'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createWhatsAppClient, sendText: defaultSendText } = require('../services/whatsappClient');
const { normalizePhone } = require('../utils/phone');
const {
  validateJobRefundProjection,
  validateCanonicalRefundOccurrence,
} = require('./noDriverRefund');

const LEASE_DURATION_MS = 60000; // 60 seconds
const MAX_ATTEMPTS = 5;

const OUTBOX_EXACT_KEYS = Object.freeze([
  'attemptCount', 'channel', 'createdAt', 'eventId', 'eventType', 'lastErrorCode',
  'leaseUntil', 'nextAttemptAt', 'ownerToken', 'payload', 'payloadVersion',
  'providerMessageId', 'recipientKey', 'resourceId', 'resourceType', 'sentAt',
  'state', 'updatedAt',
]);

const OUTBOX_ALLOWED_EVENT_TYPES = Object.freeze([
  'job_accepted',
  'job_in_progress',
  'job_completed',
  'job_cancelled_customer',
  'job_cancelled_system',
  'refund_confirmed',
]);

const OUTBOX_ALLOWED_STATES = Object.freeze([
  'pending',
  'in_progress',
  'retry_wait',
  'sent',
  'failed_terminal',
]);

const OUTBOX_ALLOWED_ERROR_CODES = Object.freeze([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_rejected_message',
  'provider_unknown_error',
  'recipient_unreachable',
  'configuration_missing',
  'internal_error',
]);

const EVENT_CONFIGS = Object.freeze({
  job_accepted: {
    resourceType: 'job',
    jobStatus: 'accepted',
    hasOffer: true,
    refundAmountPaise: null,
  },
  job_in_progress: {
    resourceType: 'job',
    jobStatus: 'in_progress',
    hasOffer: false,
    refundAmountPaise: null,
  },
  job_completed: {
    resourceType: 'job',
    jobStatus: 'completed',
    hasOffer: false,
    refundAmountPaise: null,
  },
  job_cancelled_customer: {
    resourceType: 'job',
    jobStatus: 'cancelled_customer',
    hasOffer: false,
    refundAmountPaise: null,
  },
  job_cancelled_system: {
    resourceType: 'job',
    jobStatus: 'cancelled_system',
    hasOffer: false,
    refundAmountPaise: null,
  },
  refund_confirmed: {
    resourceType: 'refund_request',
    jobStatus: 'cancelled_system',
    hasOffer: false,
    refundAmountPaise: 'positive_integer',
  },
});

function exactKeys(obj, expectedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const actual = Object.keys(obj);
  if (actual.length !== expectedKeys.length) return false;
  const expectedSet = new Set(expectedKeys);
  return actual.every(k => expectedSet.has(k));
}

function isAuthoritativeTimestamp(ts, TimestampClass) {
  if (!ts || typeof ts !== 'object') return false;
  if (TimestampClass && ts instanceof TimestampClass) return true;
  return typeof ts.toMillis === 'function' &&
         typeof ts.nanoseconds === 'number' &&
         Number.isSafeInteger(ts.seconds);
}

function safeTimestampsEqual(a, b, TimestampClass) {
  if (a === null && b === null) return true;
  if (!isAuthoritativeTimestamp(a, TimestampClass) || !isAuthoritativeTimestamp(b, TimestampClass)) return false;
  return a.seconds === b.seconds && a.nanoseconds === b.nanoseconds;
}

function safeTimestampLessThanOrEqual(early, late, TimestampClass) {
  if (!isAuthoritativeTimestamp(early, TimestampClass) || !isAuthoritativeTimestamp(late, TimestampClass)) return false;
  if (early.seconds < late.seconds) return true;
  if (early.seconds > late.seconds) return false;
  return early.nanoseconds <= late.nanoseconds;
}

function timestampMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (Number.isSafeInteger(ts.seconds)) return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1000000);
  return null;
}

function validateCanonicalNotificationOutbox(outbox, { TimestampClass, expectedEventId = null, documentId = null } = {}) {
  if (!outbox || typeof outbox !== 'object' || Array.isArray(outbox)) return false;
  if (!exactKeys(outbox, OUTBOX_EXACT_KEYS)) return false;

  if (documentId !== null && documentId !== undefined) {
    if (typeof documentId !== 'string' || !documentId || outbox.eventId !== documentId) return false;
  }
  if (expectedEventId !== null && expectedEventId !== undefined) {
    if (typeof expectedEventId !== 'string' || !expectedEventId || outbox.eventId !== expectedEventId) return false;
  }

  if (!OUTBOX_ALLOWED_EVENT_TYPES.includes(outbox.eventType)) return false;
  const config = EVENT_CONFIGS[outbox.eventType];
  if (!config) return false;

  if (outbox.resourceType !== config.resourceType) return false;
  if (outbox.channel !== 'whatsapp') return false;
  if (typeof outbox.resourceId !== 'string' || !outbox.resourceId) return false;
  if (outbox.recipientKey !== 'customer:' + outbox.resourceId) return false;

  if (config.hasOffer) {
    const prefix = `${outbox.eventType}:${outbox.resourceId}:`;
    if (!outbox.eventId.startsWith(prefix) || outbox.eventId.length <= prefix.length) return false;
  } else {
    if (outbox.eventId !== `${outbox.eventType}:${outbox.resourceId}`) return false;
  }

  if (outbox.payloadVersion !== 1) return false;
  if (!outbox.payload || typeof outbox.payload !== 'object' || Array.isArray(outbox.payload)) return false;
  if (!exactKeys(outbox.payload, ['jobId', 'jobStatus', 'refundAmountPaise'])) return false;
  if (outbox.payload.jobId !== outbox.resourceId) return false;
  if (outbox.payload.jobStatus !== config.jobStatus) return false;

  if (config.refundAmountPaise === 'positive_integer') {
    if (!Number.isSafeInteger(outbox.payload.refundAmountPaise) || outbox.payload.refundAmountPaise <= 0) return false;
  } else {
    if (outbox.payload.refundAmountPaise !== null) return false;
  }

  if (!OUTBOX_ALLOWED_STATES.includes(outbox.state)) return false;
  if (!Number.isSafeInteger(outbox.attemptCount) || outbox.attemptCount < 0 || outbox.attemptCount > MAX_ATTEMPTS) return false;

  if (!isAuthoritativeTimestamp(outbox.createdAt, TimestampClass)) return false;
  if (!isAuthoritativeTimestamp(outbox.updatedAt, TimestampClass)) return false;
  if (!safeTimestampLessThanOrEqual(outbox.createdAt, outbox.updatedAt, TimestampClass)) return false;

  if (outbox.leaseUntil !== null && !isAuthoritativeTimestamp(outbox.leaseUntil, TimestampClass)) return false;
  if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) return false;
  if (outbox.ownerToken !== null && (typeof outbox.ownerToken !== 'string' || outbox.ownerToken.length === 0)) return false;
  if (outbox.sentAt !== null && !isAuthoritativeTimestamp(outbox.sentAt, TimestampClass)) return false;
  if (outbox.lastErrorCode !== null && !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)) return false;
  if (outbox.providerMessageId !== null && (typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0)) return false;

  if (outbox.state === 'pending') {
    if (
      outbox.attemptCount !== 0 ||
      outbox.ownerToken !== null ||
      outbox.leaseUntil !== null ||
      !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
      outbox.providerMessageId !== null ||
      outbox.lastErrorCode !== null ||
      outbox.sentAt !== null
    ) {
      return false;
    }
  } else if (outbox.state === 'in_progress') {
    if (
      outbox.attemptCount < 1 ||
      typeof outbox.ownerToken !== 'string' || outbox.ownerToken.length === 0 ||
      !isAuthoritativeTimestamp(outbox.leaseUntil, TimestampClass) ||
      outbox.providerMessageId !== null ||
      outbox.sentAt !== null
    ) {
      return false;
    }
  } else if (outbox.state === 'retry_wait') {
    if (
      outbox.attemptCount < 1 ||
      outbox.attemptCount >= MAX_ATTEMPTS ||
      outbox.ownerToken !== null ||
      outbox.leaseUntil !== null ||
      !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
      !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode) ||
      outbox.providerMessageId !== null ||
      outbox.sentAt !== null
    ) {
      return false;
    }
  } else if (outbox.state === 'sent') {
    if (
      outbox.attemptCount < 1 ||
      outbox.ownerToken !== null ||
      outbox.leaseUntil !== null ||
      outbox.nextAttemptAt !== null ||
      !isAuthoritativeTimestamp(outbox.sentAt, TimestampClass) ||
      typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.trim().length === 0 ||
      outbox.lastErrorCode !== null ||
      !safeTimestampLessThanOrEqual(outbox.createdAt, outbox.sentAt, TimestampClass) ||
      !safeTimestampLessThanOrEqual(outbox.sentAt, outbox.updatedAt, TimestampClass)
    ) {
      return false;
    }
  } else if (outbox.state === 'failed_terminal') {
    if (
      outbox.attemptCount < 1 ||
      outbox.ownerToken !== null ||
      outbox.leaseUntil !== null ||
      outbox.nextAttemptAt !== null ||
      outbox.providerMessageId !== null ||
      outbox.sentAt !== null ||
      !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)
    ) {
      return false;
    }
  }

  return true;
}

function renderNotificationMessage(eventType, payload) {
  const jobId = payload.jobId;
  switch (eventType) {
    case 'job_accepted':
      return `Your towing request ${jobId} has been accepted by a driver.`;
    case 'job_in_progress':
      return `Your towing job ${jobId} is now in progress.`;
    case 'job_completed':
      return `Your towing job ${jobId} has been completed.`;
    case 'job_cancelled_customer':
      return `Your towing job ${jobId} has been cancelled.`;
    case 'job_cancelled_system':
      return `Your towing request ${jobId} was cancelled because no driver was available.`;
    case 'refund_confirmed': {
      const amountRupees = (payload.refundAmountPaise / 100).toFixed(2);
      return `A refund of INR ${amountRupees} for booking ${jobId} has been processed to your original payment method.`;
    }
    default:
      throw new Error(`Unsupported eventType: ${eventType}`);
  }
}

function calculateBackoffMs(attemptCount) {
  if (attemptCount === 1) return 30000;
  if (attemptCount === 2) return 60000;
  if (attemptCount === 3) return 120000;
  if (attemptCount === 4) return 300000;
  return 300000;
}

function classifyProviderError(error) {
  if (!error) {
    return { code: 'internal_error', retryable: false };
  }

  // 1. Missing configuration (terminal)
  if (
    error.code === 'CONFIGURATION_ERROR' ||
    error.code === 'CONFIGURATION_MISSING' ||
    error.message?.includes('Missing required configuration') ||
    error.message?.includes('WHATSAPP_GRAPH_API_VERSION') ||
    error.message?.includes('WHATSAPP_ACCESS_TOKEN') ||
    error.message?.includes('WHATSAPP_PHONE_NUMBER_ID')
  ) {
    return { code: 'configuration_missing', retryable: false };
  }

  // 2. Internal error (terminal)
  if (
    error.code === 'internal_error' ||
    error.code === 'INTERNAL_ERROR' ||
    error.name === 'InternalError' ||
    error.message?.includes('Refund money/state contradiction')
  ) {
    return { code: 'internal_error', retryable: false };
  }

  // 3. Recipient unreachable / invalid phone (terminal)
  if (
    error.code === 'RECIPIENT_UNREACHABLE' ||
    (error.name === 'TypeError' && (error.message?.includes('Recipient') || error.message?.includes('Phone'))) ||
    error.message?.includes('Recipient must be normalized E.164') ||
    error.message?.includes('Phone number') ||
    error.message?.includes('131026') || // Meta undeliverable
    error.message?.includes('not a valid whatsapp')
  ) {
    return { code: 'recipient_unreachable', retryable: false };
  }

  // 4. Timeout / Network error (transient)
  if (
    error.name === 'AbortError' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ENOTFOUND' ||
    error.message?.includes('timed out') ||
    error.message?.includes('timeout') ||
    error.message?.includes('network') ||
    error.message?.includes('fetch failed')
  ) {
    return { code: 'provider_unavailable', retryable: true };
  }

  const rawMsg = error.message || '';
  const statusMatch = /WhatsApp API error: (\d{3})/.exec(rawMsg);
  const rawStatus = error.status || (statusMatch ? Number(statusMatch[1]) : null);

  // 5. Rate limited (transient)
  if (rawStatus === 429 || rawMsg.includes('130429') || rawMsg.toLowerCase().includes('rate limit')) {
    return { code: 'provider_rate_limited', retryable: true };
  }

  // 6. Server errors (transient)
  if (rawStatus && [500, 502, 503, 504].includes(rawStatus)) {
    return { code: 'provider_unavailable', retryable: true };
  }

  // 7. 4xx Permanent provider rejection (terminal)
  if (
    rawStatus === 400 ||
    rawStatus === 401 ||
    rawStatus === 403 ||
    rawMsg.includes('131047') || // outside 24-hr customer service window
    rawMsg.includes('132000') ||
    rawMsg.includes('100') ||
    rawMsg.includes('did not accept')
  ) {
    return { code: 'provider_rejected_message', retryable: false };
  }

  if (rawStatus && rawStatus >= 500) {
    return { code: 'provider_unavailable', retryable: true };
  }

  if (rawStatus && rawStatus >= 400 && rawStatus < 500) {
    return { code: 'provider_rejected_message', retryable: false };
  }

  return { code: 'provider_unknown_error', retryable: false };
}

function assertWhatsAppConfig(env = process.env) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_ACCESS_TOKEN.trim()) {
    const err = new Error('Missing required configuration: WHATSAPP_ACCESS_TOKEN');
    err.code = 'CONFIGURATION_ERROR';
    throw err;
  }
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_PHONE_NUMBER_ID.trim()) {
    const err = new Error('Missing required configuration: WHATSAPP_PHONE_NUMBER_ID');
    err.code = 'CONFIGURATION_ERROR';
    throw err;
  }
  const graphVersion = env.WHATSAPP_GRAPH_API_VERSION ? env.WHATSAPP_GRAPH_API_VERSION.trim() : '';
  if (!graphVersion || !/^v\d+\.\d+$/.test(graphVersion)) {
    const err = new Error('Invalid WHATSAPP_GRAPH_API_VERSION');
    err.code = 'CONFIGURATION_ERROR';
    throw err;
  }
  return true;
}

function createNotificationDeliveryManager({
  db = getFirestore(),
  whatsapp = { sendText: defaultSendText },
  TimestampClass = Timestamp,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  env = process.env,
  leaseDurationMs = LEASE_DURATION_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  function currentMillis() {
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'number') return now;
    if (typeof now === 'function') {
      const val = now();
      if (val instanceof Date) return val.getTime();
      if (typeof val === 'number') return val;
    }
    return Date.now();
  }

  async function deliverNotification(eventId) {
    if (typeof eventId !== 'string' || !eventId) {
      return { claimed: false, status: 'rejected', reason: 'INVALID_EVENT_ID' };
    }

    const outboxRef = db.collection('notification_outbox').doc(eventId);

    // ── Phase 1: Claim Transaction ───────────────────────────────────────────
    const claim = await db.runTransaction(async tx => {
      const outboxSnap = await tx.get(outboxRef);
      if (!outboxSnap.exists) {
        return { claimed: false, status: 'missing' };
      }
      const outbox = outboxSnap.data();

      // Document-identity binding check MUST precede absorbing state checks
      if (
        outboxSnap.id !== eventId ||
        outbox.eventId !== eventId ||
        !validateCanonicalNotificationOutbox(outbox, {
          TimestampClass,
          expectedEventId: eventId,
          documentId: eventId,
        })
      ) {
        return { claimed: false, status: 'malformed', outbox };
      }

      if (outbox.state === 'sent') {
        return { claimed: false, status: 'sent', outbox };
      }
      if (outbox.state === 'failed_terminal') {
        return { claimed: false, status: 'failed_terminal', outbox };
      }

      const nowMs = currentMillis();
      const nowTs = TimestampClass.fromMillis(nowMs);

      if (outbox.state === 'pending') {
        const nextAttemptMs = timestampMillis(outbox.nextAttemptAt);
        if (nextAttemptMs !== null && nextAttemptMs > nowMs) {
          return { claimed: false, status: 'pending', reason: 'not_due', outbox };
        }
        if (outbox.attemptCount !== 0 || outbox.ownerToken !== null || outbox.leaseUntil !== null) {
          return { claimed: false, status: 'malformed', outbox };
        }
        const ownerToken = randomUUID();
        const leaseUntil = TimestampClass.fromMillis(nowMs + leaseDurationMs);
        tx.update(outboxRef, {
          state: 'in_progress',
          ownerToken,
          leaseUntil,
          attemptCount: 1,
          updatedAt: nowTs,
        });
        return {
          claimed: true,
          ownerToken,
          attemptCount: 1,
          leaseUntil,
          outbox: { ...outbox, state: 'in_progress', ownerToken, leaseUntil, attemptCount: 1, updatedAt: nowTs },
        };
      }

      if (outbox.state === 'retry_wait') {
        const nextAttemptMs = timestampMillis(outbox.nextAttemptAt);
        if (nextAttemptMs !== null && nextAttemptMs > nowMs) {
          return { claimed: false, status: 'retry_wait', reason: 'not_due', outbox };
        }
        if (outbox.attemptCount < 1 || outbox.attemptCount >= maxAttempts) {
          return { claimed: false, status: 'malformed', outbox };
        }
        const ownerToken = randomUUID();
        const newAttemptCount = outbox.attemptCount + 1;
        const leaseUntil = TimestampClass.fromMillis(nowMs + leaseDurationMs);
        tx.update(outboxRef, {
          state: 'in_progress',
          ownerToken,
          leaseUntil,
          attemptCount: newAttemptCount,
          updatedAt: nowTs,
        });
        return {
          claimed: true,
          ownerToken,
          attemptCount: newAttemptCount,
          leaseUntil,
          outbox: { ...outbox, state: 'in_progress', ownerToken, leaseUntil, attemptCount: newAttemptCount, updatedAt: nowTs },
        };
      }

      if (outbox.state === 'in_progress') {
        const leaseUntilMs = timestampMillis(outbox.leaseUntil);
        if (leaseUntilMs !== null && leaseUntilMs > nowMs) {
          return { claimed: false, status: 'in_progress', reason: 'active_lease', outbox };
        }
        if (outbox.attemptCount >= maxAttempts) {
          return { claimed: false, status: 'in_progress', reason: 'max_attempts_exceeded', outbox };
        }
        const ownerToken = randomUUID();
        const newAttemptCount = outbox.attemptCount + 1;
        const leaseUntil = TimestampClass.fromMillis(nowMs + leaseDurationMs);
        tx.update(outboxRef, {
          ownerToken,
          leaseUntil,
          attemptCount: newAttemptCount,
          updatedAt: nowTs,
        });
        return {
          claimed: true,
          ownerToken,
          attemptCount: newAttemptCount,
          leaseUntil,
          outbox: { ...outbox, ownerToken, leaseUntil, attemptCount: newAttemptCount, updatedAt: nowTs },
        };
      }

      return { claimed: false, status: outbox.state, reason: 'unhandled_state', outbox };
    });

    if (!claim.claimed) {
      return claim;
    }

    const { outbox, ownerToken, attemptCount } = claim;

    // ── Phase 2: Recipient Resolution, Consistency Checks & External Send ────
    let sendResult = null;
    let sendError = null;

    try {
      // Configuration verification
      if (typeof whatsapp.assertConfigured === 'function') {
        whatsapp.assertConfigured();
      } else if (env !== process.env || whatsapp.sendText === defaultSendText) {
        assertWhatsAppConfig(env);
      }

      // Recipient resolution
      const jobId = outbox.resourceId;
      const jobSnap = await db.collection('jobs').doc(jobId).get();
      if (!jobSnap.exists) {
        const err = new Error(`Job ${jobId} not found`);
        err.code = outbox.eventType === 'refund_confirmed' ? 'internal_error' : 'RECIPIENT_UNREACHABLE';
        throw err;
      }
      const job = jobSnap.data();

      // Read-only consistency checks
      if (outbox.eventType === 'refund_confirmed') {
        const refundSnap = await db.collection('refund_requests').doc(jobId).get();
        if (!refundSnap.exists) {
          const err = new Error(`Refund request ${jobId} not found`);
          err.code = 'internal_error';
          throw err;
        }
        const refund = refundSnap.data();

        const nowMs = currentMillis();
        const projectionValid =
          refund &&
          typeof refund === 'object' &&
          !Array.isArray(refund) &&
          refund.state === 'confirmed' &&
          validateJobRefundProjection(job, refund, { TimestampClass, nowMs }) &&
          validateCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs);

        if (!projectionValid) {
          const err = new Error(`Refund confirmation projection contradiction on job ${jobId}`);
          err.code = 'internal_error';
          throw err;
        }

        const canonicalAmount = refund.amountPaise;
        if (
          outbox.resourceId !== jobId ||
          outbox.payload?.jobId !== jobId ||
          outbox.payload?.jobStatus !== 'cancelled_system' ||
          outbox.payload?.refundAmountPaise !== canonicalAmount
        ) {
          const err = new Error(`Refund outbox payload contradiction on job ${jobId}`);
          err.code = 'internal_error';
          throw err;
        }
      }

      if (typeof job.customerPhone !== 'string' || !job.customerPhone.trim()) {
        const err = new Error(`Job ${jobId} missing customerPhone`);
        err.code = 'RECIPIENT_UNREACHABLE';
        throw err;
      }

      const normalizedPhone = normalizePhone(job.customerPhone);
      const messageBody = renderNotificationMessage(outbox.eventType, outbox.payload);

      sendResult = await whatsapp.sendText(normalizedPhone, messageBody);
      if (!sendResult || typeof sendResult.messageId !== 'string' || !sendResult.messageId.trim()) {
        const err = new Error('WhatsApp API did not accept the outbound message');
        err.code = 'provider_rejected_message';
        throw err;
      }
    } catch (err) {
      sendError = err;
      sendResult = null;
    }

    // ── Phase 3: Finalize Transaction ────────────────────────────────────────
    return await db.runTransaction(async tx => {
      const outboxSnap = await tx.get(outboxRef);
      if (!outboxSnap.exists) {
        return { finalized: false, reason: 'document_disappeared' };
      }
      const current = outboxSnap.data();

      // Terminal winner preservation
      if (current.state === 'sent') {
        return { claimed: true, finalized: true, status: 'sent', preserved: true };
      }
      if (current.state === 'failed_terminal') {
        return { claimed: true, finalized: true, status: 'failed_terminal', preserved: true };
      }

      // Fencing check: verify in_progress and identical ownerToken
      if (current.state !== 'in_progress' || current.ownerToken !== ownerToken) {
        return { claimed: true, finalized: false, status: current.state, reason: 'fenced' };
      }

      const nowMs = currentMillis();
      const nowTs = TimestampClass.fromMillis(nowMs);

      if (sendResult) {
        // Provider Success -> sent
        tx.update(outboxRef, {
          state: 'sent',
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: null,
          providerMessageId: sendResult.messageId,
          lastErrorCode: null,
          sentAt: nowTs,
          updatedAt: nowTs,
        });
        return { claimed: true, finalized: true, status: 'sent', messageId: sendResult.messageId };
      }

      // Provider Failure
      const classified = classifyProviderError(sendError);

      if (!classified.retryable || attemptCount >= maxAttempts) {
        // Terminal error OR max attempts reached -> failed_terminal
        tx.update(outboxRef, {
          state: 'failed_terminal',
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: null,
          lastErrorCode: classified.code,
          updatedAt: nowTs,
        });
        return { claimed: true, finalized: true, status: 'failed_terminal', lastErrorCode: classified.code };
      }

      // Transient error -> retry_wait
      const backoffMs = calculateBackoffMs(attemptCount);
      const nextDue = TimestampClass.fromMillis(nowMs + backoffMs);

      tx.update(outboxRef, {
        state: 'retry_wait',
        ownerToken: null,
        leaseUntil: null,
        nextAttemptAt: nextDue,
        lastErrorCode: classified.code,
        updatedAt: nowTs,
      });
      return { claimed: true, finalized: true, status: 'retry_wait', nextAttemptAt: nextDue, lastErrorCode: classified.code };
    });
  }

  async function deliverPendingNotifications({ batchSize = 25 } = {}) {
    const counts = { discovered: 0, delivered: 0, failed: 0, skipped: 0 };
    const nowMs = currentMillis();
    const nowTimestamp = TimestampClass.fromMillis(nowMs);

    // Preflight config check before batch sweep
    try {
      if (typeof whatsapp.assertConfigured === 'function') {
        whatsapp.assertConfigured();
      } else if (env !== process.env || whatsapp.sendText === defaultSendText) {
        assertWhatsAppConfig(env);
      }
    } catch {
      return { ...counts, unconfigured: true };
    }

    // 1. Pending Due
    {
      let lastDoc = null;
      while (counts.delivered < batchSize) {
        let q = db.collection('notification_outbox')
          .where('state', '==', 'pending')
          .where('nextAttemptAt', '<=', nowTimestamp)
          .orderBy('nextAttemptAt')
          .limit(batchSize);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await deliverNotification(doc.id);
            if (res?.status === 'sent') counts.delivered++;
            else if (res?.status === 'failed_terminal' || res?.status === 'malformed') counts.failed++;
            else if (!res?.claimed) counts.skipped++;
          } catch {
            counts.failed++;
          }
          if (counts.delivered >= batchSize) break;
        }
        if (counts.delivered >= batchSize || snap.docs.length < batchSize) break;
      }
    }

    // 2. Retry_Wait Due
    {
      let lastDoc = null;
      while (counts.delivered < batchSize) {
        let q = db.collection('notification_outbox')
          .where('state', '==', 'retry_wait')
          .where('nextAttemptAt', '<=', nowTimestamp)
          .orderBy('nextAttemptAt')
          .limit(batchSize);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await deliverNotification(doc.id);
            if (res?.status === 'sent') counts.delivered++;
            else if (res?.status === 'failed_terminal' || res?.status === 'malformed') counts.failed++;
            else if (!res?.claimed) counts.skipped++;
          } catch {
            counts.failed++;
          }
          if (counts.delivered >= batchSize) break;
        }
        if (counts.delivered >= batchSize || snap.docs.length < batchSize) break;
      }
    }

    // 3. Expired in_progress Leases
    {
      let lastDoc = null;
      while (counts.delivered < batchSize) {
        let q = db.collection('notification_outbox')
          .where('state', '==', 'in_progress')
          .where('leaseUntil', '<=', nowTimestamp)
          .orderBy('leaseUntil')
          .limit(batchSize);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await deliverNotification(doc.id);
            if (res?.status === 'sent') counts.delivered++;
            else if (res?.status === 'failed_terminal' || res?.status === 'malformed') counts.failed++;
            else if (!res?.claimed) counts.skipped++;
          } catch {
            counts.failed++;
          }
          if (counts.delivered >= batchSize) break;
        }
        if (counts.delivered >= batchSize || snap.docs.length < batchSize) break;
      }
    }

    return counts;
  }

  return {
    deliverNotification,
    deliverPendingNotifications,
  };
}

function shouldProcessNotificationCreated(event) {
  if (!event?.data?.exists) return false;
  const data = typeof event.data.data === 'function' ? event.data.data() : null;
  if (!data || data.state !== 'pending') return false;
  if (event.params?.eventId !== undefined && event.params?.eventId !== null) {
    if (typeof event.params.eventId !== 'string' || data.eventId !== event.params.eventId) {
      return false;
    }
  }
  return true;
}

let defaultManager;
function productionNotificationManager() {
  if (!defaultManager) {
    defaultManager = createNotificationDeliveryManager();
  }
  return defaultManager;
}

module.exports = {
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  OUTBOX_EXACT_KEYS,
  OUTBOX_ALLOWED_EVENT_TYPES,
  OUTBOX_ALLOWED_STATES,
  OUTBOX_ALLOWED_ERROR_CODES,
  EVENT_CONFIGS,
  validateCanonicalNotificationOutbox,
  renderNotificationMessage,
  calculateBackoffMs,
  classifyProviderError,
  assertWhatsAppConfig,
  createNotificationDeliveryManager,
  shouldProcessNotificationCreated,
  productionNotificationManager,
};
