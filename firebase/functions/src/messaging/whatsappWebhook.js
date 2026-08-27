'use strict';

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { verifySignature, safeCompare } = require('../utils/hmac');
const { createIdempotencyService, IdempotencyError } = require('../utils/idempotency');
const { requireEnv } = require('../utils/env');
const { normalizePhone } = require('../utils/phone');
const { normalizeCoordinates } = require('../utils/haversine');
const { createJobAndQuote } = require('../services/jobService');
const { sendText } = require('../services/whatsappClient');
const {
  getPaymentLinksByReferenceId,
  getPaymentLink,
  cancelPaymentLink,
} = require('../services/razorpayClient');

const SESSION_LEASE_MS = 60000;

class WhatsAppProcessingError extends Error {
  constructor(message, code = 'WHATSAPP_PROCESSING_ERROR', status = 500) {
    super(message);
    this.name = 'WhatsAppProcessingError';
    this.code = code;
    this.status = status;
  }
}

function createWhatsAppWebhook({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => Date.now(),
  env = process.env,
  verifySignatureFn = verifySignature,
  idempotency = createIdempotencyService({ db, TimestampClass, now }),
  jobs = { createJobAndQuote },
  whatsapp = { sendText },
  razorpay = { getPaymentLinksByReferenceId, getPaymentLink, cancelPaymentLink },
  sessionLeaseMs = SESSION_LEASE_MS,
} = {}) {
  async function handleWhatsAppWebhook(req, res) {
    if (req.method === 'GET') {
      let verifyToken;
      try {
        verifyToken = requireEnv('WHATSAPP_VERIFY_TOKEN', env);
      } catch (error) {
        console.error('WhatsApp verification configuration error', error);
        return res.status(500).send('Webhook not configured');
      }
      const mode = req.query?.['hub.mode'];
      const token = req.query?.['hub.verify_token'];
      const challenge = req.query?.['hub.challenge'];
      if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') {
        return res.sendStatus(400);
      }
      if (!safeCompare(token, verifyToken)) return res.sendStatus(403);
      return res.status(200).send(challenge);
    }
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    let appSecret;
    try {
      appSecret = requireEnv('WHATSAPP_APP_SECRET', env);
    } catch (error) {
      console.error('WhatsApp webhook configuration error', error);
      return res.status(500).send('Webhook not configured');
    }
    const signature = header(req, 'x-hub-signature-256');
    if (!Buffer.isBuffer(req.rawBody) || !verifySignatureFn(req.rawBody, signature, appSecret, 'sha256=')) {
      return res.status(401).send('Invalid signature');
    }
    if (req.body?.object !== 'whatsapp_business_account') return res.sendStatus(404);

    let notifications;
    try {
      notifications = extractNotifications(req.body);
    } catch (error) {
      console.error('Malformed WhatsApp webhook payload', error);
      return res.status(400).send('Invalid payload');
    }
    let retryRequired = false;
    for (const notification of notifications) {
      if (notification.kind === 'status') continue;
      const message = notification.message;
      if (typeof message.id !== 'string' || !message.id || typeof message.from !== 'string') {
        return res.status(400).send('Invalid message');
      }
      let phone;
      try {
        phone = normalizePhone(message.from);
      } catch (error) {
        console.error('Invalid WhatsApp sender', error);
        return res.status(400).send('Invalid sender');
      }
      const identity = `meta:${message.id}`;
      try {
        const result = await idempotency.executeIdempotent(identity, 'whatsapp_message', ownerToken =>
          processMessage(phone, message, message.id, ownerToken)
        );
        if (result.status !== 200) retryRequired = true;
      } catch (error) {
        console.error('WhatsApp message processing failed', error);
        retryRequired = true;
      }
    }
    if (retryRequired) return res.status(503).send('Processing incomplete; retry required');
    return res.sendStatus(200);
  }

  async function processMessage(phone, message, messageId, ownerToken) {
    const sessionRef = db.collection('whatsapp_sessions').doc(phone);
    try {
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const plan = await claimAndPlan(sessionRef, phone, message, messageId, ownerToken);
        if (plan.kind === 'done') return;
        const recoveringOlderMessage = plan.reply.messageId !== messageId;
        let recoveredClaim;
        if (recoveringOlderMessage) {
          recoveredClaim = await idempotency.claimLease(
            `meta:${plan.reply.messageId}`,
            'whatsapp_message'
          );
          if (recoveredClaim.completed) {
            throw new WhatsAppProcessingError('Completed message still has pending session work');
          }
        }
        try {
          if (plan.kind === 'cancel_unpaid') {
            await performUnpaidCancellation(sessionRef, phone, messageId, ownerToken, plan);
          } else if (plan.kind === 'job_quote') {
            await performJobQuote(sessionRef, phone, messageId, ownerToken, plan);
          } else if (plan.kind === 'text') {
            await sendAndFinalizeText(sessionRef, phone, messageId, ownerToken, plan.reply);
          } else {
            throw new WhatsAppProcessingError('Unknown session plan');
          }
          if (recoveredClaim) {
            await idempotency.markCompleted(
              `meta:${plan.reply.messageId}`,
              recoveredClaim.ownerToken
            );
          }
        } catch (error) {
          if (recoveredClaim) {
            await idempotency.markFailed(
              `meta:${plan.reply.messageId}`,
              recoveredClaim.ownerToken
            );
          }
          throw error;
        }
        if (plan.kind === 'text' && !recoveringOlderMessage) return;
      }
      throw new WhatsAppProcessingError('Session recovery exceeded bounded steps');
    } catch (error) {
      await releaseSessionOwnership(sessionRef, messageId, ownerToken);
      throw error;
    }
  }

  async function claimAndPlan(sessionRef, phone, message, messageId, ownerToken) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sessionRef);
      const session = snapshot.exists ? snapshot.data() : newSession(phone);
      const nowMs = now();
      if (session.lastProcessedMessageId === messageId) return { kind: 'done' };

      const leaseActive = timestampMillis(session.processingLeaseUntil) > nowMs;
      if (session.processingMessageId && session.processingOwnerToken !== ownerToken && leaseActive) {
        throw new IdempotencyError('Another message owns the active session lease', 503);
      }
      const leaseUpdate = {
        processingMessageId: messageId,
        processingOwnerToken: ownerToken,
        processingLeaseUntil: TimestampClass.fromMillis(nowMs + sessionLeaseMs),
        updatedAt: TimestampClass.fromMillis(nowMs),
      };

      if (session.pendingReply) {
        validatePendingReply(session.pendingReply);
        transaction.set(sessionRef, leaseUpdate, { merge: true });
        return pendingPlan(session, session.pendingReply);
      }

      const text = message.type === 'text' && typeof message.text?.body === 'string'
        ? message.text.body.trim().toLowerCase()
        : '';
      if (text === 'cancel') {
        return planCancellation(transaction, sessionRef, session, messageId, leaseUpdate);
      }

      const update = { ...leaseUpdate };
      let replyBody;
      if (session.state === 1) {
        if (message.type === 'location') {
          update.pickupCoords = parseLocation(message.location);
          update.state = 2;
          replyBody = 'Please share your DESTINATION location pin.';
        } else {
          replyBody = 'Please share your PICKUP location pin.';
        }
      } else if (session.state === 2) {
        if (message.type === 'location') {
          update.destCoords = parseLocation(message.location);
          update.state = 3;
          replyBody = 'Which towing category? Reply 1 for Flatbed or 2 for Pulling/Tochan/Crane.';
        } else {
          replyBody = 'Please share your DESTINATION location pin.';
        }
      } else if (session.state === 3) {
        const requestedTruckType = parseTruckType(text);
        if (!requestedTruckType) {
          replyBody = 'Invalid category. Reply 1 for Flatbed or 2 for Pulling/Tochan/Crane.';
        } else {
          const jobId = session.jobId || db.collection('jobs').doc().id;
          const pendingReply = { kind: 'job_quote', messageId, jobId };
          Object.assign(update, { state: 4, requestedTruckType, jobId, pendingReply });
          transaction.set(sessionRef, { ...session, ...update }, { merge: true });
          return {
            kind: 'job_quote',
            reply: pendingReply,
            jobId,
            pickupCoords: session.pickupCoords,
            destCoords: session.destCoords,
            requestedTruckType,
          };
        }
      } else if (session.state === 4) {
        throw new WhatsAppProcessingError('Fare-quote state is missing its recoverable pending work');
      } else if (session.state === 5) {
        replyBody = 'Your booking is awaiting payment or dispatch. Reply CANCEL to request cancellation.';
      } else {
        throw new WhatsAppProcessingError(`Invalid WhatsApp session state: ${session.state}`);
      }

      const pendingReply = { kind: 'text', messageId, body: replyBody };
      update.pendingReply = pendingReply;
      transaction.set(sessionRef, { ...session, ...update }, { merge: true });
      return { kind: 'text', reply: pendingReply };
    });
  }

  async function planCancellation(transaction, sessionRef, session, messageId, leaseUpdate) {
    const textReply = body => ({ kind: 'text', messageId, body });
    if (!session.jobId) {
      const reply = textReply('Cancelled. Send a message to start a new booking.');
      transaction.set(sessionRef, {
        ...session,
        ...leaseUpdate,
        ...resetBookingFields(),
        pendingReply: reply,
      }, { merge: true });
      return { kind: 'text', reply };
    }
    const jobRef = db.collection('jobs').doc(session.jobId);
    const jobSnapshot = await transaction.get(jobRef);
    if (!jobSnapshot.exists) throw new WhatsAppProcessingError('Session references a missing job');
    const job = jobSnapshot.data();
    const timestamp = TimestampClass.fromMillis(now());

    if (job.status === 'completed') {
      const reply = textReply('This job is already completed and cannot be cancelled.');
      transaction.set(sessionRef, { ...leaseUpdate, pendingReply: reply }, { merge: true });
      return { kind: 'text', reply };
    }
    if (job.status === 'awaiting_payment' && !job.paymentConfirmedAt) {
      transaction.update(jobRef, {
        cancellationRequestedAt: job.cancellationRequestedAt || timestamp,
        cancellationReason: job.cancellationReason || 'customer_requested',
        updatedAt: timestamp,
      });
      const pendingReply = {
        kind: 'cancel_unpaid',
        messageId,
        jobId: session.jobId,
        bookingFeePaise: job.bookingFeePaise,
        localPaymentLinkId: job.razorpayPaymentLinkId || null,
      };
      transaction.set(sessionRef, { ...leaseUpdate, pendingReply }, { merge: true });
      return {
        kind: 'cancel_unpaid',
        reply: pendingReply,
        jobId: session.jobId,
        bookingFeePaise: job.bookingFeePaise,
        localPaymentLinkId: job.razorpayPaymentLinkId,
      };
    }
    if (job.status === 'pending_offer') {
      transaction.update(jobRef, {
        status: 'cancelled_customer',
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationRequestedAt: job.cancellationRequestedAt || timestamp,
        updatedAt: timestamp,
      });
      const reply = textReply('Booking cancelled. The booking fee is non-refundable. Send a message to start a new booking.');
      transaction.set(sessionRef, {
        ...leaseUpdate,
        ...resetBookingFields(),
        pendingReply: reply,
      }, { merge: true });
      return { kind: 'text', reply };
    }
    if (['offered', 'accepted', 'in_progress'].includes(job.status)) {
      transaction.update(jobRef, {
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationRequestedAt: job.cancellationRequestedAt || timestamp,
        updatedAt: timestamp,
      });
      const reply = textReply('Cancellation requested. The booking fee is non-refundable; dispatch resolution is pending.');
      transaction.set(sessionRef, { ...leaseUpdate, pendingReply: reply }, { merge: true });
      return { kind: 'text', reply };
    }
    if (['cancelled_customer', 'cancelled_driver', 'cancelled_system'].includes(job.status)) {
      const reply = textReply('This booking is already cancelled. Send a message to start a new booking.');
      transaction.set(sessionRef, {
        ...leaseUpdate,
        ...resetBookingFields(),
        pendingReply: reply,
      }, { merge: true });
      return { kind: 'text', reply };
    }
    throw new WhatsAppProcessingError(`Cannot cancel job from state ${job.status}`);
  }

  async function performJobQuote(sessionRef, phone, currentMessageId, ownerToken, plan) {
    const result = await jobs.createJobAndQuote(
      plan.jobId,
      phone,
      plan.pickupCoords,
      plan.destCoords,
      plan.requestedTruckType,
      'whatsapp'
    );
    const body = [
      `Estimated towing fare: INR ${(result.estimatedFarePaise / 100).toFixed(2)} (payable directly to the driver).`,
      `Booking fee: INR ${(result.bookingFeePaise / 100).toFixed(2)}. Pay here: ${result.razorpayPaymentLinkUrl}`,
    ].join('\n');
    const reply = await replacePendingWithText(sessionRef, currentMessageId, ownerToken, plan.reply, body, {
      state: 5,
    });
    await sendAndFinalizeText(sessionRef, phone, currentMessageId, ownerToken, reply);
  }

  async function performUnpaidCancellation(sessionRef, phone, currentMessageId, ownerToken, plan) {
    const outcome = await reconcilePaymentLinkCancellation(plan.jobId, plan.bookingFeePaise, plan.localPaymentLinkId);
    const jobRef = db.collection('jobs').doc(plan.jobId);
    const body = await db.runTransaction(async transaction => {
      const [sessionSnapshot, jobSnapshot] = await Promise.all([
        transaction.get(sessionRef),
        transaction.get(jobRef),
      ]);
      assertSessionOwner(sessionSnapshot, currentMessageId, ownerToken);
      if (!jobSnapshot.exists) throw new WhatsAppProcessingError('Cancellation job disappeared');
      const session = sessionSnapshot.data();
      const job = jobSnapshot.data();
      assertMatchingPending(session.pendingReply, plan.reply);
      const timestamp = TimestampClass.fromMillis(now());
      if (outcome.kind === 'paid' || job.paymentConfirmedAt) {
        const paidCancellationConverged = Boolean(
          job.paymentConfirmedAt &&
          job.status === 'cancelled_customer' &&
          job.cancelledBy === 'customer' &&
          job.cancellationReason === 'customer_requested'
        );
        const paidBody = paidCancellationConverged
          ? 'Payment confirmed and booking cancelled. The booking fee is non-refundable. Send a message to start a new booking.'
          : 'Payment succeeded during cancellation. The booking fee is non-refundable; payment reconciliation is pending.';
        transaction.update(sessionRef, {
          ...(paidCancellationConverged ? resetBookingFields() : {}),
          pendingReply: { kind: 'text', messageId: plan.reply.messageId, body: paidBody },
          processingLeaseUntil: TimestampClass.fromMillis(now() + sessionLeaseMs),
          updatedAt: timestamp,
        });
        return paidBody;
      }
      if (job.status !== 'awaiting_payment') {
        throw new WhatsAppProcessingError(`Cancellation recovery found job state ${job.status}`);
      }
      transaction.update(jobRef, {
        status: 'cancelled_customer',
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationRequestedAt: job.cancellationRequestedAt || timestamp,
        updatedAt: timestamp,
      });
      const cancelledBody = 'Booking cancelled. Send a message to start a new booking.';
      transaction.update(sessionRef, {
        ...resetBookingFields(),
        pendingReply: { kind: 'text', messageId: plan.reply.messageId, body: cancelledBody },
        processingLeaseUntil: TimestampClass.fromMillis(now() + sessionLeaseMs),
        updatedAt: timestamp,
      });
      return cancelledBody;
    });
    await sendAndFinalizeText(sessionRef, phone, currentMessageId, ownerToken, {
      kind: 'text',
      messageId: plan.reply.messageId,
      body,
    });
  }

  async function reconcilePaymentLinkCancellation(jobId, amount, localPaymentLinkId) {
    let link;
    if (localPaymentLinkId) {
      link = await razorpay.getPaymentLink(localPaymentLinkId);
    } else {
      const candidates = await razorpay.getPaymentLinksByReferenceId(jobId);
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new WhatsAppProcessingError('No Razorpay Payment Link exists to cancel', 'PAYMENT_LINK_NOT_FOUND', 503);
      }
      if (candidates.length !== 1) {
        throw new WhatsAppProcessingError('Multiple Payment Links match the cancellation', 'PAYMENT_LINK_AMBIGUOUS');
      }
      [link] = candidates;
    }
    validateCancellationLink(link, jobId, amount, localPaymentLinkId);
    await persistRecoveredLink(jobId, link);
    if (link.status === 'paid') return { kind: 'paid', link };
    if (['cancelled', 'expired'].includes(link.status)) return { kind: 'cancelled', link };
    try {
      const cancelled = await razorpay.cancelPaymentLink(link.id);
      validateCancellationLink(cancelled, jobId, amount, link.id);
      if (cancelled.status !== 'cancelled' || cancelled.amount_paid !== 0) {
        throw new WhatsAppProcessingError('Razorpay did not confirm unpaid cancellation');
      }
      return { kind: 'cancelled', link: cancelled };
    } catch (error) {
      const recovered = await razorpay.getPaymentLink(link.id);
      validateCancellationLink(recovered, jobId, amount, link.id);
      if (recovered.status === 'paid') return { kind: 'paid', link: recovered };
      if (['cancelled', 'expired'].includes(recovered.status)) return { kind: 'cancelled', link: recovered };
      throw error;
    }
  }

  async function persistRecoveredLink(jobId, link) {
    const jobRef = db.collection('jobs').doc(jobId);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new WhatsAppProcessingError('Job disappeared during Payment Link recovery');
      const job = snapshot.data();
      if (job.razorpayPaymentLinkId && job.razorpayPaymentLinkId !== link.id) {
        throw new WhatsAppProcessingError('Recovered Payment Link conflicts with local job');
      }
      if (job.razorpayPaymentLinkUrl && job.razorpayPaymentLinkUrl !== link.short_url) {
        throw new WhatsAppProcessingError('Recovered Payment Link URL conflicts with local job');
      }
      transaction.update(jobRef, {
        razorpayPaymentLinkId: link.id,
        razorpayPaymentLinkUrl: link.short_url,
        updatedAt: TimestampClass.fromMillis(now()),
      });
    });
  }

  async function replacePendingWithText(sessionRef, currentMessageId, ownerToken, expected, body, extra) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sessionRef);
      assertSessionOwner(snapshot, currentMessageId, ownerToken);
      const session = snapshot.data();
      assertMatchingPending(session.pendingReply, expected);
      const reply = { kind: 'text', messageId: expected.messageId, body };
      transaction.update(sessionRef, {
        ...extra,
        pendingReply: reply,
        processingLeaseUntil: TimestampClass.fromMillis(now() + sessionLeaseMs),
        updatedAt: TimestampClass.fromMillis(now()),
      });
      return reply;
    });
  }

  async function sendAndFinalizeText(sessionRef, phone, currentMessageId, ownerToken, reply) {
    await renewSessionOwnership(sessionRef, currentMessageId, ownerToken, reply);
    await whatsapp.sendText(phone, reply.body);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sessionRef);
      assertSessionOwner(snapshot, currentMessageId, ownerToken);
      const session = snapshot.data();
      assertMatchingPending(session.pendingReply, reply);
      const update = {
        pendingReply: null,
        lastProcessedMessageId: reply.messageId,
        updatedAt: TimestampClass.fromMillis(now()),
      };
      if (reply.messageId === currentMessageId) {
        Object.assign(update, {
          processingMessageId: null,
          processingOwnerToken: null,
          processingLeaseUntil: null,
        });
      } else {
        update.processingLeaseUntil = TimestampClass.fromMillis(now() + sessionLeaseMs);
      }
      transaction.update(sessionRef, update);
    });
  }

  async function renewSessionOwnership(sessionRef, currentMessageId, ownerToken, reply) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sessionRef);
      assertSessionOwner(snapshot, currentMessageId, ownerToken);
      assertMatchingPending(snapshot.data().pendingReply, reply);
      const nowMs = now();
      transaction.update(sessionRef, {
        processingLeaseUntil: TimestampClass.fromMillis(nowMs + sessionLeaseMs),
        updatedAt: TimestampClass.fromMillis(nowMs),
      });
    });
  }

  async function releaseSessionOwnership(sessionRef, messageId, ownerToken) {
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(sessionRef);
        if (!snapshot.exists) return;
        const session = snapshot.data();
        if (session.processingMessageId !== messageId || session.processingOwnerToken !== ownerToken) return;
        transaction.update(sessionRef, {
          processingMessageId: null,
          processingOwnerToken: null,
          processingLeaseUntil: null,
          updatedAt: TimestampClass.fromMillis(now()),
        });
      });
    } catch (error) {
      console.error('Failed to release WhatsApp session ownership', error);
    }
  }

  return {
    handleWhatsAppWebhook,
    processMessage,
    reconcilePaymentLinkCancellation,
  };
}

function extractNotifications(body) {
  if (!Array.isArray(body.entry)) return [];
  const notifications = [];
  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes)) throw new TypeError('entry.changes must be an array');
    for (const change of entry.changes) {
      const value = change?.value;
      if (!value || typeof value !== 'object') throw new TypeError('change.value is required');
      if (value.messages !== undefined) {
        if (!Array.isArray(value.messages)) throw new TypeError('messages must be an array');
        for (const message of value.messages) notifications.push({ kind: 'message', message });
      }
      if (value.statuses !== undefined) {
        if (!Array.isArray(value.statuses)) throw new TypeError('statuses must be an array');
        for (const status of value.statuses) notifications.push({ kind: 'status', status });
      }
    }
  }
  return notifications;
}

function newSession(phone) {
  return {
    phoneNumber: phone,
    state: 1,
    pickupCoords: null,
    destCoords: null,
    requestedTruckType: null,
    jobId: null,
    pendingReply: null,
    lastProcessedMessageId: null,
  };
}

function resetBookingFields() {
  return {
    state: 1,
    pickupCoords: null,
    destCoords: null,
    requestedTruckType: null,
    jobId: null,
  };
}

function pendingPlan(session, pending) {
  if (pending.kind === 'text') return { kind: 'text', reply: pending };
  if (pending.kind === 'cancel_unpaid') {
    return {
      kind: 'cancel_unpaid',
      reply: pending,
      jobId: pending.jobId,
      bookingFeePaise: pending.bookingFeePaise,
      localPaymentLinkId: pending.localPaymentLinkId,
    };
  }
  if (pending.kind === 'job_quote') {
    return {
      kind: 'job_quote',
      reply: pending,
      jobId: pending.jobId,
      pickupCoords: session.pickupCoords,
      destCoords: session.destCoords,
      requestedTruckType: session.requestedTruckType,
    };
  }
  throw new WhatsAppProcessingError('Unknown pending reply kind');
}

function validatePendingReply(pending) {
  if (!pending || typeof pending !== 'object' || typeof pending.messageId !== 'string') {
    throw new WhatsAppProcessingError('Malformed pending reply');
  }
  if (!['text', 'job_quote', 'cancel_unpaid'].includes(pending.kind)) {
    throw new WhatsAppProcessingError('Malformed pending reply kind');
  }
  if (pending.kind === 'text' && (typeof pending.body !== 'string' || !pending.body)) {
    throw new WhatsAppProcessingError('Malformed pending text reply');
  }
}

function assertSessionOwner(snapshot, messageId, ownerToken) {
  if (!snapshot.exists) throw new IdempotencyError('WhatsApp session ownership was lost', 503);
  const session = snapshot.data();
  if (session.processingMessageId !== messageId || session.processingOwnerToken !== ownerToken) {
    throw new IdempotencyError('WhatsApp session ownership was lost', 503);
  }
}

function assertMatchingPending(actual, expected) {
  if (
    !actual ||
    actual.kind !== expected.kind ||
    actual.messageId !== expected.messageId ||
    (expected.jobId && actual.jobId !== expected.jobId)
  ) {
    throw new IdempotencyError('Pending WhatsApp work changed ownership', 503);
  }
}

function parseLocation(location) {
  return normalizeCoordinates({ lat: location?.latitude, lng: location?.longitude }, 'WhatsApp location');
}

function parseTruckType(text) {
  if (['1', 'flatbed'].includes(text)) return 'flatbed';
  if (['2', 'pulling', 'tochan', 'crane'].includes(text)) return 'pulling';
  return null;
}

function validateCancellationLink(link, jobId, amount, expectedId) {
  if (!link || typeof link !== 'object') throw new WhatsAppProcessingError('Invalid Payment Link recovery response');
  if (typeof link.id !== 'string' || !/^plink_[A-Za-z0-9]+$/.test(link.id)) {
    throw new WhatsAppProcessingError('Invalid Payment Link ID');
  }
  if (expectedId && link.id !== expectedId) throw new WhatsAppProcessingError('Payment Link ID mismatch');
  if (link.reference_id !== jobId || link.currency !== 'INR' || link.amount !== amount || link.accept_partial !== false) {
    throw new WhatsAppProcessingError('Payment Link does not match the job');
  }
  if (typeof link.short_url !== 'string' || !/^https:\/\//.test(link.short_url)) {
    throw new WhatsAppProcessingError('Payment Link has no secure URL');
  }
  if (!['created', 'paid', 'cancelled', 'expired'].includes(link.status)) {
    throw new WhatsAppProcessingError(`Unsupported Payment Link status ${link.status}`);
  }
  if (link.status === 'paid' && link.amount_paid !== amount) {
    throw new WhatsAppProcessingError('Paid Payment Link amount mismatch');
  }
  if (link.status !== 'paid' && ![0, undefined].includes(link.amount_paid)) {
    throw new WhatsAppProcessingError('Unpaid Payment Link has a paid amount');
  }
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return NaN;
}

function header(req, name) {
  return req.get?.(name) || req.headers?.[name] || req.headers?.[name.toLowerCase()];
}

let defaultWebhook;
function getDefaultWebhook() {
  if (!defaultWebhook) defaultWebhook = createWhatsAppWebhook();
  return defaultWebhook;
}

module.exports = {
  SESSION_LEASE_MS,
  WhatsAppProcessingError,
  createWhatsAppWebhook,
  handleWhatsAppWebhook: (...args) => getDefaultWebhook().handleWhatsAppWebhook(...args),
};
