'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is required; this suite never silently skips');
}

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const {
  createIdempotencyService,
  OwnershipLostError,
} = require('../../../firebase/functions/src/utils/idempotency');
const {
  createJobService,
  JobIntegrityError,
  ProvisioningBusyError,
} = require('../../../firebase/functions/src/services/jobService');
const { createInvoiceService } = require('../../../firebase/functions/src/services/invoiceService');
const { createOtpService } = require('../../../firebase/functions/src/services/otpService');
const { createWhatsAppWebhook } = require('../../../firebase/functions/src/messaging/whatsappWebhook');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');

if (getApps().length === 0) {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'towing-phase3-emulator' });
}
const db = getFirestore();

test('real Firestore permits one concurrent idempotency claimant and fences a reclaimed owner', async () => {
  const identity = `emulator:${crypto.randomUUID()}`;
  let now = Date.now();
  let token = 0;
  const service = createIdempotencyService({
    db,
    TimestampClass: Timestamp,
    now: () => now,
    randomUUID: () => `owner-${++token}`,
    leaseMs: 100,
  });
  try {
    const claims = await Promise.allSettled([
      service.claimLease(identity, 'emulator_test'),
      service.claimLease(identity, 'emulator_test'),
    ]);
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(claims.filter(result => result.status === 'rejected').length, 1);
    const oldOwner = claims.find(result => result.status === 'fulfilled').value.ownerToken;
    now += 200;
    const reclaimed = await service.claimLease(identity, 'emulator_test');
    await assert.rejects(service.markCompleted(identity, oldOwner), OwnershipLostError);
    await service.markCompleted(identity, reclaimed.ownerToken);
    assert.equal((await db.collection('processed_requests').doc(identity).get()).data().status, 'completed');
  } finally {
    await db.collection('processed_requests').doc(identity).delete();
  }
});

test('real Firestore provisioning lease prevents concurrent duplicate Payment Link creation', async () => {
  const jobId = `ej-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let owner = 0;
  let createCalls = 0;
  let signalCreate;
  const createStarted = new Promise(resolve => { signalCreate = resolve; });
  let releaseCreate;
  const createMayFinish = new Promise(resolve => { releaseCreate = resolve; });
  const service = createJobService({
    db,
    TimestampClass: Timestamp,
    now: () => new Date('2026-08-25T20:00:00Z'),
    randomUUID: () => `provision-owner-${++owner}`,
    pricing: {
      getPricingConfig: async () => ({}),
      calculateCommission: () => ({ tier: 1, bookingFeePaise: 50000, driverCommissionPaise: 25000 }),
      calculateFare: () => ({ estimatedFarePaise: 200000 }),
    },
    razorpay: {
      getPaymentLinksByReferenceId: async () => [],
      createPaymentLink: async input => {
        createCalls += 1;
        signalCreate();
        await createMayFinish;
        return {
          id: 'plink_EMULATOR1', reference_id: input.reference_id, amount: input.amount,
          amount_paid: 0, currency: 'INR', accept_partial: false, status: 'created',
          short_url: 'https://rzp.io/i/emulator',
        };
      },
    },
  });
  const args = [
    jobId, '+919876543210', { lat: 19, lng: 73 }, { lat: 19.1, lng: 73.1 }, 'flatbed', 'whatsapp',
  ];
  try {
    const first = service.createJobAndQuote(...args);
    await createStarted;
    await assert.rejects(service.createJobAndQuote(...args), ProvisioningBusyError);
    releaseCreate();
    const created = await first;
    assert.equal(created.razorpayPaymentLinkId, 'plink_EMULATOR1');
    assert.equal(createCalls, 1);
  } finally {
    releaseCreate?.();
    await db.collection('jobs').doc(jobId).delete();
  }
});

test('real Firestore session lease rejects a competing message owner', async () => {
  const phone = `+919${String(Date.now()).slice(-9)}`;
  let signalSend;
  const sendStarted = new Promise(resolve => { signalSend = resolve; });
  let releaseSend;
  const sendMayFinish = new Promise(resolve => { releaseSend = resolve; });
  const webhook = createWhatsAppWebhook({
    db,
    TimestampClass: Timestamp,
    now: () => Date.now(),
    env: {},
    whatsapp: {
      sendText: async () => {
        signalSend();
        await sendMayFinish;
        return { messageId: 'wamid.emulator.outbound' };
      },
    },
  });
  const firstMessage = { id: 'session-first', from: phone.slice(1), type: 'text', text: { body: 'hello' } };
  const secondMessage = { id: 'session-second', from: phone.slice(1), type: 'text', text: { body: 'hello' } };
  try {
    const first = webhook.processMessage(phone, firstMessage, firstMessage.id, 'session-owner-1');
    await sendStarted;
    await assert.rejects(
      webhook.processMessage(phone, secondMessage, secondMessage.id, 'session-owner-2'),
      /active session lease/
    );
    releaseSend();
    await first;
    const session = (await db.collection('whatsapp_sessions').doc(phone).get()).data();
    assert.equal(session.lastProcessedMessageId, firstMessage.id);
  } finally {
    releaseSend?.();
    await db.collection('whatsapp_sessions').doc(phone).delete();
  }
});

test('real Firestore atomically creates one immutable job and rejects a conflicting retry', async () => {
  const jobId = `im-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let createCalls = 0;
  const service = createJobService({
    db,
    TimestampClass: Timestamp,
    now: () => new Date('2026-08-25T20:00:00Z'),
    randomUUID: () => crypto.randomUUID(),
    pricing: {
      getPricingConfig: async () => ({}),
      calculateCommission: () => ({ tier: 1, bookingFeePaise: 50000, driverCommissionPaise: 25000 }),
      calculateFare: () => ({ estimatedFarePaise: 200000 }),
    },
    razorpay: {
      getPaymentLinksByReferenceId: async () => [],
      createPaymentLink: async input => {
        createCalls += 1;
        return {
          id: 'plink_IMMUTABLE1', reference_id: input.reference_id, amount: input.amount,
          amount_paid: 0, currency: 'INR', accept_partial: false, status: 'created',
          short_url: 'https://rzp.io/i/immutable',
        };
      },
    },
  });
  const common = [{ lat: 19, lng: 73 }, { lat: 19.1, lng: 73.1 }, 'flatbed', 'whatsapp'];
  try {
    const results = await Promise.allSettled([
      service.createJobAndQuote(jobId, '+919876543210', ...common),
      service.createJobAndQuote(jobId, '+919999999999', ...common),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected.reason instanceof JobIntegrityError);
    assert.equal(createCalls, 1);
    const stored = (await db.collection('jobs').doc(jobId).get()).data();
    assert.ok(['+919876543210', '+919999999999'].includes(stored.customerPhone));
  } finally {
    await db.collection('jobs').doc(jobId).delete();
  }
});

test('real Firestore assigns one invoice number per job under concurrent retries', async () => {
  const jobId = `emulator-invoice-${crypto.randomUUID()}`;
  await db.collection('business_config').doc('main').set({
    businessName: 'Emulator Towing',
    gstin: '27ABCDE1234F1Z5',
    registeredAddress: 'Navi Mumbai',
    invoiceNumberCounter: 0,
  });
  await db.collection('jobs').doc(jobId).set({
    customerPhone: '+919876543210', requestedTruckType: 'flatbed', bookingFeePaise: 50000,
    razorpayPaymentId: 'pay_EMULATOR1', paymentConfirmedAt: Timestamp.now(),
    invoiceNumber: null,
  });
  const service = createInvoiceService({
    db,
    TimestampClass: Timestamp,
    now: () => new Date('2026-08-25T20:00:00Z'),
    storage: {},
    whatsapp: {},
  });
  try {
    const [first, second] = await Promise.all([
      service.allocateInvoiceNumber(jobId),
      service.allocateInvoiceNumber(jobId),
    ]);
    assert.equal(first.invoiceNumber, 'TDS-0001');
    assert.equal(second.invoiceNumber, 'TDS-0001');
    assert.equal((await db.collection('business_config').doc('main').get()).data().invoiceNumberCounter, 1);
  } finally {
    await Promise.all([
      db.collection('jobs').doc(jobId).delete(),
      db.collection('business_config').doc('main').delete(),
    ]);
  }
});

test('real Firestore permits only one concurrent consumption of an unchanged OTP challenge', async () => {
  const phone = `+919${String(Date.now()).slice(-9)}`;
  const now = Date.now();
  await db.collection('business_config').doc('main').set({
    otpPolicy: {
      otpExpirySeconds: 300,
      resendCooldownSeconds: 60,
      maxSendsPerWindow: 5,
      sendWindowSeconds: 900,
      blockDurationSeconds: 3600,
      maxVerificationAttempts: 5,
    },
  }, { merge: true });
  await db.collection('driver_otps').doc(phone).set({
    challengeId: 'challenge-emulator',
    hash: 'a'.repeat(128),
    salt: 'b'.repeat(32),
    expiresAt: Timestamp.fromMillis(now + 300000),
    attempts: 0,
    consumedAt: null,
  });
  let verifyCalls = 0;
  const waiting = [];
  const service = createOtpService({
    db,
    TimestampClass: Timestamp,
    now: () => now,
    env: { OTP_PEPPER: 'emulator-pepper' },
    cryptoOps: {
      generateOtp: () => '123456',
      hashOtp: async () => ({ hash: 'a'.repeat(128), salt: 'b'.repeat(32) }),
      verifyOtp: async () => {
        verifyCalls += 1;
        if (verifyCalls < 2) await new Promise(resolve => waiting.push(resolve));
        waiting.splice(0).forEach(resolve => resolve());
        return true;
      },
    },
    whatsapp: {},
    auth: {
      getUserByPhoneNumber: async () => ({ uid: 'emulator-driver' }),
      createUser: async () => ({ uid: 'emulator-driver' }),
      createCustomToken: async () => 'emulator-token',
    },
  });
  try {
    const results = await Promise.allSettled([
      service.verifyDriverOtp(phone, '123456'),
      service.verifyDriverOtp(phone, '123456'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const challenge = (await db.collection('driver_otps').doc(phone).get()).data();
    assert.ok(challenge.consumedAt);
    assert.equal(challenge.attempts, 2);
  } finally {
    await Promise.all([
      db.collection('driver_otps').doc(phone).delete(),
      db.collection('business_config').doc('main').delete(),
    ]);
  }
});

test('real Firestore CANCEL then PAYMENT race preserves payment and never dispatches', async () => {
  const jobId = `cp-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const phone = `+918${String(Date.now()).slice(-9)}`;
  const paymentLinkId = 'plink_CANCELPAY1';
  const paymentId = 'pay_CANCELPAY1';
  const jobRef = db.collection('jobs').doc(jobId);
  const sessionRef = db.collection('whatsapp_sessions').doc(phone);
  await jobRef.set({
    customerPhone: phone,
    status: 'awaiting_payment',
    bookingFeePaise: 50000,
    razorpayPaymentLinkId: paymentLinkId,
    razorpayPaymentLinkUrl: 'https://rzp.io/i/cancelpay',
    razorpayPaymentId: null,
    paymentConfirmedAt: null,
    cancellationRequestedAt: null,
  });
  await sessionRef.set({
    phoneNumber: phone,
    state: 5,
    jobId,
    pendingReply: null,
    lastProcessedMessageId: null,
  });
  let signalLookup;
  const lookupStarted = new Promise(resolve => { signalLookup = resolve; });
  let releaseLookup;
  const lookupMayFinish = new Promise(resolve => { releaseLookup = resolve; });
  let invoiceCalls = 0;
  let dispatchCalls = 0;
  const whatsappWebhook = createWhatsAppWebhook({
    db,
    TimestampClass: Timestamp,
    now: () => Date.now(),
    env: {},
    whatsapp: { sendText: async () => ({ messageId: 'wamid.cancelpay' }) },
    razorpay: {
      getPaymentLinksByReferenceId: async () => [],
      getPaymentLink: async () => {
        const marked = (await jobRef.get()).data();
        assert.ok(marked.cancellationRequestedAt);
        signalLookup();
        await lookupMayFinish;
        return {
          id: paymentLinkId, reference_id: jobId, currency: 'INR', amount: 50000,
          amount_paid: 50000, accept_partial: false, status: 'paid',
          short_url: 'https://rzp.io/i/cancelpay',
        };
      },
      cancelPaymentLink: async () => assert.fail('paid link must not be cancelled'),
    },
  });
  const paymentWebhook = createRazorpayWebhook({
    db,
    TimestampClass: Timestamp,
    now: () => Date.now(),
    env: {},
    invoice: { ensureInvoiceAndSend: async () => { invoiceCalls += 1; } },
    dispatch: { triggerDispatch: async () => { dispatchCalls += 1; } },
  });
  const message = { id: 'cancel-pay-message', from: phone.slice(1), type: 'text', text: { body: 'CANCEL' } };
  try {
    const cancellation = whatsappWebhook.processMessage(
      phone, message, message.id, 'cancel-pay-owner'
    );
    await lookupStarted;
    await paymentWebhook.processPayment({
      paymentLinkId,
      jobId,
      paymentId,
      amountPaise: 50000,
    });
    releaseLookup();
    await cancellation;
    const job = (await jobRef.get()).data();
    assert.equal(job.status, 'cancelled_customer');
    assert.equal(job.cancelledBy, 'customer');
    assert.equal(job.cancellationReason, 'customer_requested');
    assert.equal(job.razorpayPaymentId, paymentId);
    assert.ok(job.paymentConfirmedAt);
    assert.equal(job.razorpayRefundId, undefined);
    assert.equal(invoiceCalls, 1);
    assert.equal(dispatchCalls, 0);
    let session = (await sessionRef.get()).data();
    assert.equal(session.state, 1);
    assert.equal(session.jobId, null);
    assert.equal(session.pendingReply, null);

    const nextMessage = {
      id: 'after-cancel-payment',
      from: phone.slice(1),
      type: 'text',
      text: { body: 'hello' },
    };
    await whatsappWebhook.processMessage(
      phone, nextMessage, nextMessage.id, 'after-cancel-payment-owner'
    );
    session = (await sessionRef.get()).data();
    assert.equal(session.state, 1);
    assert.equal(session.jobId, null);
    assert.equal(session.lastProcessedMessageId, nextMessage.id);
  } finally {
    releaseLookup?.();
    await Promise.all([jobRef.delete(), sessionRef.delete()]);
  }
});
