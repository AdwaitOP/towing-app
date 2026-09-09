'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { verifySignature } = require('../utils/hmac');
const { createIdempotencyService } = require('../utils/idempotency');
const { validateRazorpayPayload } = require('../utils/razorpayPayload');
const { requireEnv } = require('../utils/env');
const { ensureInvoiceAndSend } = require('../services/invoiceService');
const { triggerDispatch } = require('../jobs/dispatchBoundary');
const {
  validateRefundConfirmedOutbox,
  REFUND_REQUEST_KEYS,
  validateRefundRequestRecord,
  validateRefundRequestLifecycle,
  validateJobRefundProjection,
  validateCanonicalRefundOccurrence,
  validateConfirmedOccurrence,
  validateConfirmedWinner,
  isValidRefundId,
  isAuthoritativeTimestamp,
  timestampsEqual,
  timestampsInOrder,
  safeTimestampsEqual,
  compareTimestamps,
} = require('../dispatch/noDriverRefund');
const { exactKeys, timestampMillis } = require('../dispatch/dispatchValidation');

class WebhookProcessingError extends Error {
  constructor(message, code = 'WEBHOOK_PROCESSING_ERROR') {
    super(message);
    this.name = 'WebhookProcessingError';
    this.code = code;
  }
}

function createRazorpayWebhook({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => Date.now(),
  env = process.env,
  verifySignatureFn = verifySignature,
  idempotency = createIdempotencyService({ db, TimestampClass, now }),
  invoice = { ensureInvoiceAndSend },
  dispatch = { triggerDispatch },
} = {}) {
  async function handleRazorpayWebhook(req, res) {
    let secret;
    try {
      secret = requireEnv('RAZORPAY_WEBHOOK_SECRET', env);
    } catch (error) {
      console.error('Razorpay webhook configuration error', error);
      return res.status(500).send('Webhook not configured');
    }
    const signature = header(req, 'x-razorpay-signature');
    if (!Buffer.isBuffer(req.rawBody) || !verifySignatureFn(req.rawBody, signature, secret)) {
      return res.status(401).send('Invalid signature');
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const event = req.body?.event;
    if (!['payment_link.paid', 'refund.processed'].includes(event)) {
      return res.status(200).send('Event ignored');
    }

    let parsed;
    try {
      parsed = validateRazorpayPayload(req.body);
    } catch (error) {
      console.error('Razorpay payload validation failed', error);
      return res.status(400).send('Invalid payload');
    }

    const identity = event === 'payment_link.paid'
      ? `razorpay:payment_link.paid:${parsed.paymentId}`
      : `razorpay:refund.processed:${parsed.refundId}`;

    try {
      const result = await idempotency.executeIdempotent(identity, 'razorpay_webhook', async () => {
        if (event === 'payment_link.paid') return processPayment(parsed);
        return processRefund(parsed);
      });
      if (result.status !== 200) return res.status(result.status).send(result.message);
      return res.sendStatus(200);
    } catch (error) {
      console.error('Razorpay webhook processing failed', error);
      return res.status(500).send('Processing incomplete; retry required');
    }
  }

  async function processPayment({ paymentLinkId, jobId, paymentId, amountPaise }) {
    const jobRef = db.collection('jobs').doc(jobId);
    const state = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new WebhookProcessingError('Payment references an unknown job', 'JOB_NOT_FOUND');
      const job = snapshot.data();
      if (job.razorpayPaymentLinkId !== paymentLinkId) {
        throw new WebhookProcessingError('Payment Link ID does not match job', 'PAYMENT_LINK_MISMATCH');
      }
      if (job.bookingFeePaise !== amountPaise) {
        throw new WebhookProcessingError('Paid amount does not match booking fee', 'PAYMENT_AMOUNT_MISMATCH');
      }
      const hasStoredPaymentId = markerPresent(job.razorpayPaymentId);
      const hasPaymentConfirmation = markerPresent(job.paymentConfirmedAt);
      if (hasStoredPaymentId && (typeof job.razorpayPaymentId !== 'string' || !job.razorpayPaymentId)) {
        throw new WebhookProcessingError('Stored payment ID is invalid', 'PAYMENT_MARKERS_INCONSISTENT');
      }
      if (hasStoredPaymentId && job.razorpayPaymentId !== paymentId) {
        throw new WebhookProcessingError('A different payment ID is already stored', 'PAYMENT_ID_MISMATCH');
      }
      if (hasPaymentConfirmation && !hasStoredPaymentId) {
        throw new WebhookProcessingError('Confirmed payment is missing its payment ID', 'PAYMENT_MARKERS_INCONSISTENT');
      }
      if (hasPaymentConfirmation && !validTimestamp(job.paymentConfirmedAt)) {
        throw new WebhookProcessingError('Payment confirmation timestamp is invalid', 'PAYMENT_MARKERS_INCONSISTENT');
      }
      if (hasPaymentConfirmation) {
        if (job.status === 'awaiting_payment') {
          throw new WebhookProcessingError('Confirmed payment has an invalid awaiting_payment state');
        }
        const repair = cancelledCustomerRepair(job);
        if (repair) {
          const timestamp = TimestampClass.fromMillis(now());
          transaction.update(jobRef, { ...repair, updatedAt: timestamp });
        }
        return {
          jobId,
          customerPhone: job.customerPhone,
          status: job.status,
          alreadyConfirmed: true,
        };
      }

      let nextStatus;
      let cancellationFields = {};
      if (job.status === 'awaiting_payment') {
        if (job.cancellationRequestedAt) {
          if (markerPresent(job.cancellationReason) && job.cancellationReason !== 'customer_requested') {
            throw new WebhookProcessingError('Cancellation provenance is contradictory');
          }
          nextStatus = 'cancelled_customer';
          cancellationFields = {
            cancelledBy: 'customer',
            cancellationReason: 'customer_requested',
          };
        } else {
          nextStatus = 'pending_offer';
        }
      } else if (job.status === 'pending_offer' && job.razorpayPaymentId === paymentId) {
        nextStatus = 'pending_offer';
      } else if (
        job.status === 'cancelled_customer' &&
        job.cancellationReason === 'customer_requested' &&
        (!markerPresent(job.cancelledBy) || job.cancelledBy === 'customer')
      ) {
        nextStatus = 'cancelled_customer';
        cancellationFields = { cancelledBy: 'customer', cancellationReason: 'customer_requested' };
      } else {
        throw new WebhookProcessingError(`Cannot confirm first payment from state ${job.status}`);
      }
      const timestamp = TimestampClass.fromMillis(now());
      transaction.update(jobRef, {
        razorpayPaymentId: paymentId,
        paymentConfirmedAt: timestamp,
        status: nextStatus,
        ...cancellationFields,
        updatedAt: timestamp,
      });
      return {
        jobId,
        customerPhone: job.customerPhone,
        status: nextStatus,
        alreadyConfirmed: false,
      };
    });

    const work = [invoice.ensureInvoiceAndSend(jobId)];
    if (state.status === 'pending_offer') {
      work.push((async () => {
        const current = await jobRef.get();
        if (current.exists && current.data().status === 'pending_offer') {
          return dispatch.triggerDispatch(jobId);
        }
        return { dispatched: false, reason: 'job_no_longer_pending_offer' };
      })());
    } else if (state.status === 'cancelled_customer') {
      work.push(recoverCancelledCustomerSession(state.jobId, state.customerPhone));
    }
    const settled = await Promise.allSettled(work);
    const failures = settled.filter(result => result.status === 'rejected');
    if (failures.length) {
      const error = new WebhookProcessingError('Post-payment recovery work is incomplete', 'PAYMENT_RECOVERY_INCOMPLETE');
      error.causes = failures.map(result => result.reason);
      throw error;
    }
    return state;
  }

  async function recoverCancelledCustomerSession(jobId, customerPhone) {
    if (typeof customerPhone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(customerPhone)) {
      throw new WebhookProcessingError('Cancelled paid job has an invalid customer phone');
    }
    const sessionRef = db.collection('whatsapp_sessions').doc(customerPhone);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sessionRef);
      if (!snapshot.exists) return { reset: false, reason: 'session_missing' };
      const session = snapshot.data();
      if (session.jobId !== jobId) return { reset: false, reason: 'newer_booking' };
      if (
        markerPresent(session.processingMessageId) ||
        markerPresent(session.processingOwnerToken) ||
        markerPresent(session.pendingReply)
      ) {
        return { reset: false, reason: 'active_owner' };
      }
      transaction.update(sessionRef, {
        state: 1,
        pickupCoords: null,
        destCoords: null,
        requestedTruckType: null,
        jobId: null,
        updatedAt: TimestampClass.fromMillis(now()),
      });
      return { reset: true };
    });
  }

  async function processRefund({ refundId, paymentId, amountPaise }) {
    const query = await db.collection('jobs')
      .where('razorpayPaymentId', '==', paymentId)
      .limit(2)
      .get();
    if (query.empty) throw new WebhookProcessingError('Refund payment does not match a job', 'JOB_NOT_FOUND');
    if (query.size !== 1) throw new WebhookProcessingError('Refund payment matches multiple jobs', 'PAYMENT_ID_AMBIGUOUS');
    const jobRef = query.docs[0].ref;

    await db.runTransaction(async transaction => {
      const outboxId = 'refund_confirmed:' + jobRef.id;
      const refundRef = db.collection('refund_requests').doc(jobRef.id);
      const outboxRef = db.collection('notification_outbox').doc(outboxId);
      const [snapshot, refundSnap, outboxSnap] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(refundRef),
        transaction.get(outboxRef),
      ]);
      if (!snapshot.exists) throw new WebhookProcessingError('Refund job disappeared');
      const job = snapshot.data();

      // Require durable refund request for no-driver refunds
      if (!refundSnap.exists) {
        throw new WebhookProcessingError('Durable refund request required for no-driver refund', 'DOCUMENT_NOT_FOUND');
      }
      const refund = refundSnap.data();

      // Bound provider refund ID check
      if (refund.razorpayRefundId === null || refund.razorpayRefundId === undefined) {
        throw new WebhookProcessingError('Local refund provider identity not yet recorded; webhook retry required', 'REFUND_IDENTITY_UNBOUND');
      }
      if (!isValidRefundId(refund.razorpayRefundId)) {
        throw new WebhookProcessingError('Local refund provider identity format invalid', 'REFUND_ID_INVALID');
      }
      if (refund.razorpayRefundId !== refundId) {
        throw new WebhookProcessingError('A different refund ID is already stored in refund request', 'REFUND_ID_MISMATCH');
      }

      const nowMs = typeof now === 'function' ? now() : (now instanceof Date ? now.getTime() : now);
      const nowTs = TimestampClass.fromMillis(nowMs);

      // Outbox check if exists
      if (outboxSnap.exists) {
        const outbox = outboxSnap.data();
        if (!validateRefundConfirmedOutbox(outbox, { jobId: jobRef.id, amountPaise, TimestampClass })) {
          throw new WebhookProcessingError('Outbox payload mismatch', 'OUTBOX_COLLISION_INVALID');
        }
      }

      // Absorbing confirmed state validation
      const isJobConfirmed = job.refundState === 'confirmed';
      const isRefundConfirmed = refund.state === 'confirmed';

      if (isJobConfirmed || isRefundConfirmed) {
        if (!isJobConfirmed || !isRefundConfirmed) {
          throw new WebhookProcessingError('Contradictory confirmed state between job and refund', 'CONFIRMED_IDENTITY_MISMATCH');
        }
        const claim = {
          jobId: jobRef.id,
          amount: amountPaise,
          paymentId,
          refundId,
        };
        if (!validateConfirmedOccurrence(job, refund, claim, TimestampClass, nowMs)) {
          throw new WebhookProcessingError('Confirmed occurrence invalid', 'CONFIRMED_IDENTITY_MISMATCH');
        }
        // Confirmed winner requires EXISTING canonical outbox
        if (!outboxSnap.exists || !validateRefundConfirmedOutbox(outboxSnap.data(), { jobId: jobRef.id, amountPaise, TimestampClass })) {
          throw new WebhookProcessingError('Confirmed winner missing canonical outbox', 'CONFIRMED_IDENTITY_MISMATCH');
        }
        return;
      }

      // Predecessor state validation: legal predecessors for webhook confirmation
      const ALLOWED_PREDECESSORS = ['submitted', 'in_progress', 'failed_terminal'];
      if (!ALLOWED_PREDECESSORS.includes(refund.state)) {
        throw new WebhookProcessingError('Refund request state invalid for confirmation: ' + refund.state, 'REFUND_STATE_INVALID');
      }

      // Validate lifecycle & projection of predecessor
      if (!validateRefundRequestLifecycle(refund, {
        jobId: jobRef.id,
        bookingFeePaise: amountPaise,
        razorpayPaymentId: paymentId,
        TimestampClass,
        nowMs,
        allowBoundInProgress: true,
      })) {
        throw new WebhookProcessingError('Refund request lifecycle invalid', 'REFUND_SCHEMA_INVALID');
      }

      // Validate job projection against refund predecessor using canonical projection validator
      if (!validateJobRefundProjection(job, refund, { TimestampClass, nowMs, allowSubmittedJobConfirmedAt: true })) {
        throw new WebhookProcessingError('Job does not accurately project refund request', 'JOB_REFUND_STATE_CONTRADICTION');
      }

      // STEP 1: Determine the ACTUAL confirmation timestamp C
      const hasJobConfirmation = isAuthoritativeTimestamp(job.refundConfirmedAt, TimestampClass);
      const hasRefundConfirmation = isAuthoritativeTimestamp(refund.confirmedAt, TimestampClass);

      let confirmedTimestamp;
      if (hasJobConfirmation && hasRefundConfirmation) {
        if (!timestampsEqual(job.refundConfirmedAt, refund.confirmedAt, TimestampClass)) {
          throw new WebhookProcessingError('Job and refund confirmedAt timestamps disagree', 'TIMESTAMPS_INVALID');
        }
        confirmedTimestamp = job.refundConfirmedAt;
      } else if (hasJobConfirmation) {
        confirmedTimestamp = job.refundConfirmedAt;
      } else if (hasRefundConfirmation) {
        confirmedTimestamp = refund.confirmedAt;
      } else {
        confirmedTimestamp = nowTs;
      }

      // STEP 2: Validate EVERY prerequisite against confirmedTimestamp (C)
      if (compareTimestamps(confirmedTimestamp, nowTs, TimestampClass) > 0) {
        throw new WebhookProcessingError('Confirmed timestamp is in the future', 'CHRONOLOGY_VIOLATION');
      }
      if (compareTimestamps(job.paymentConfirmedAt, confirmedTimestamp, TimestampClass) > 0) {
        throw new WebhookProcessingError('Payment confirmed after confirmation timestamp', 'CHRONOLOGY_VIOLATION');
      }
      if (compareTimestamps(refund.createdAt, confirmedTimestamp, TimestampClass) > 0) {
        throw new WebhookProcessingError('Refund created after confirmation timestamp', 'CHRONOLOGY_VIOLATION');
      }
      if (refund.submittedAt !== null && compareTimestamps(refund.submittedAt, confirmedTimestamp, TimestampClass) > 0) {
        throw new WebhookProcessingError('Refund submitted after confirmation timestamp', 'CHRONOLOGY_VIOLATION');
      }

      // STEP 3: Atomic Confirmation Writes
      if (!outboxSnap.exists) {
        transaction.set(outboxRef, {
          eventId: outboxId,
          eventType: 'refund_confirmed',
          resourceType: 'refund_request',
          resourceId: jobRef.id,
          channel: 'whatsapp',
          recipientKey: 'customer:' + jobRef.id,
          payloadVersion: 1,
          payload: {
            jobId: jobRef.id,
            jobStatus: 'cancelled_system',
            refundAmountPaise: amountPaise,
          },
          state: 'pending',
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: confirmedTimestamp,
          attemptCount: 0,
          providerMessageId: null,
          lastErrorCode: null,
          createdAt: confirmedTimestamp,
          updatedAt: confirmedTimestamp,
          sentAt: null,
        });
      }

      transaction.update(jobRef, {
        refundState: 'confirmed',
        razorpayRefundId: refundId,
        refundedAmountPaise: amountPaise,
        refundConfirmedAt: confirmedTimestamp,
        refundNextAttemptAt: null,
        updatedAt: nowTs,
      });

      const refundUpdate = {
        state: 'confirmed',
        razorpayRefundId: refundId,
        confirmationSource: 'webhook',
        confirmedAt: confirmedTimestamp,
        ownerToken: null,
        leaseUntil: null,
        nextAttemptAt: null,
        reconciliationNextAttemptAt: null,
        lastErrorCode: null,
        updatedAt: nowTs,
      };
      if (refund.state === 'submitted' || refund.submittedAt !== null) {
        refundUpdate.submittedAt = refund.submittedAt;
      }
      transaction.update(refundRef, refundUpdate);
    });
    return { refundId };
  }

  return { handleRazorpayWebhook, processPayment, processRefund };
}

function header(req, name) {
  return req.get?.(name) || req.headers?.[name] || req.headers?.[name.toLowerCase()];
}

function markerPresent(value) {
  return value !== undefined && value !== null;
}

function validTimestamp(value) {
  let milliseconds;
  if (typeof value?.toMillis === 'function') milliseconds = value.toMillis();
  else if (value instanceof Date) milliseconds = value.getTime();
  return Number.isFinite(milliseconds) && milliseconds > 0;
}

function cancelledCustomerRepair(job) {
  if (job.status !== 'cancelled_customer') return null;
  if (job.cancellationReason !== 'customer_requested') {
    throw new WebhookProcessingError('Cancelled payment has ambiguous customer-cancellation provenance');
  }
  if (!markerPresent(job.cancelledBy)) return { cancelledBy: 'customer' };
  if (job.cancelledBy !== 'customer') {
    throw new WebhookProcessingError('Cancelled payment has contradictory cancellation ownership');
  }
  return null;
}

let defaultWebhook;
function getDefaultWebhook() {
  if (!defaultWebhook) defaultWebhook = createRazorpayWebhook();
  return defaultWebhook;
}

module.exports = {
  WebhookProcessingError,
  createRazorpayWebhook,
  handleRazorpayWebhook: (...args) => getDefaultWebhook().handleRazorpayWebhook(...args),
};
