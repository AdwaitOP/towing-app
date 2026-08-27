'use strict';

const { FakeFirestore, FakeStorage, FakeTimestamp, createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');
const { createInvoiceService } = require('../../../firebase/functions/src/services/invoiceService');

const now = 1_800_000_000_000;

function paidPayload(overrides = {}) {
  return {
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: {
        id: 'plink_JOB1', reference_id: 'job-1', currency: 'INR', status: 'paid',
        amount: 50000, amount_paid: 50000, accept_partial: false,
        ...(overrides.link || {}),
      } },
      payment: { entity: {
        id: 'pay_PAYMENT1', currency: 'INR', status: 'captured', amount: 50000,
        ...(overrides.payment || {}),
      } },
    },
  };
}

function request(body = paidPayload()) {
  return {
    method: 'POST',
    rawBody: Buffer.from(JSON.stringify(body)),
    body,
    headers: { 'x-razorpay-signature': 'signature' },
  };
}

function seedAwaiting(db, overrides = {}) {
  db.seed('jobs', 'job-1', {
    customerPhone: '+919876543210',
    status: 'awaiting_payment',
    bookingFeePaise: 50000,
    razorpayPaymentLinkId: 'plink_JOB1',
    razorpayPaymentId: null,
    paymentConfirmedAt: null,
    cancellationRequestedAt: null,
    ...overrides,
  });
}

function harness(options = {}) {
  const db = new FakeFirestore();
  seedAwaiting(db, options.job || {});
  const calls = { invoice: [], dispatch: [], signatures: [] };
  let invoiceFailures = options.invoiceFailures || 0;
  const webhook = createRazorpayWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { RAZORPAY_WEBHOOK_SECRET: 'webhook-secret' },
    verifySignatureFn: (...args) => { calls.signatures.push(args); return options.signatureValid !== false; },
    invoice: {
      ensureInvoiceAndSend: async jobId => {
        calls.invoice.push(jobId);
        if (invoiceFailures > 0) { invoiceFailures -= 1; throw new Error('invoice unavailable'); }
      },
    },
    dispatch: { triggerDispatch: async jobId => { calls.dispatch.push(jobId); return { dispatched: false }; } },
  });
  return { db, webhook, calls };
}

test('raw signature failure returns 401 before payload or database processing', async () => {
  const setup = harness({ signatureValid: false });
  const malformed = request({ event: 'payment_link.paid' });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(malformed, res);
  assert.equal(res.statusCode, 401);
  assert.equal(setup.calls.invoice.length, 0);
  assert.equal(setup.db.read('jobs', 'job-1').paymentConfirmedAt, null);
  assert.equal(setup.calls.signatures[0][0], malformed.rawBody);
});

test('paid webhook atomically persists payment ID and pending_offer before recovery work', async () => {
  const setup = harness();
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(job.paymentConfirmedAt.toMillis(), now);
  assert.equal(job.status, 'pending_offer');
  assert.deepEqual(setup.calls.invoice, ['job-1']);
  assert.deepEqual(setup.calls.dispatch, ['job-1']);
  assert.equal(
    setup.db.read('processed_requests', 'razorpay:payment_link.paid:pay_PAYMENT1').status,
    'completed'
  );
});

test('duplicate paid webhook uses payment ID identity and does not repeat completed work', async () => {
  const setup = harness();
  const first = createMockResponse();
  const second = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), first);
  await setup.webhook.handleRazorpayWebhook(request(), second);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(setup.calls.invoice.length, 1);
  assert.equal(setup.calls.dispatch.length, 1);
});

test('invoice failure returns 500 but leaves payment durable and still attempts dispatch handoff', async () => {
  const setup = harness({ invoiceFailures: 1 });
  const first = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), first);
  assert.equal(first.statusCode, 500);
  assert.equal(setup.db.read('jobs', 'job-1').status, 'pending_offer');
  assert.equal(setup.db.read('jobs', 'job-1').razorpayPaymentId, 'pay_PAYMENT1');
  assert.deepEqual(setup.calls.dispatch, ['job-1']);
  assert.equal(setup.db.read('processed_requests', 'razorpay:payment_link.paid:pay_PAYMENT1'), undefined);

  const retry = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(setup.calls.invoice.length, 2);
  assert.equal(setup.calls.dispatch.length, 2);
});

test('cancellation marker makes payment persist without dispatching a cancelled customer job', async () => {
  const setup = harness({
    job: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(now - 1000),
      cancellationReason: 'customer_requested',
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.cancelledBy, 'customer');
  assert.equal(job.cancellationReason, 'customer_requested');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(setup.calls.invoice.length, 1);
  assert.equal(setup.calls.dispatch.length, 0);
});

test('paid-cancellation recovery never clears a newer WhatsApp booking session', async () => {
  const setup = harness({
    job: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(now - 1000),
      cancellationReason: 'customer_requested',
    },
  });
  setup.db.seed('whatsapp_sessions', '+919876543210', {
    phoneNumber: '+919876543210',
    state: 3,
    pickupCoords: { lat: 19, lng: 73 },
    destCoords: { lat: 19.1, lng: 73.1 },
    requestedTruckType: null,
    jobId: 'job-newer',
    pendingReply: null,
    processingMessageId: null,
    processingOwnerToken: null,
  });
  const before = setup.db.read('whatsapp_sessions', '+919876543210');
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(setup.db.read('whatsapp_sessions', '+919876543210'), before);
});

test('stored payment ID mismatch never returns a false success acknowledgement', async () => {
  const setup = harness({
    job: {
      status: 'pending_offer',
      razorpayPaymentId: 'pay_DIFFERENT',
      paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(setup.calls.invoice.length, 0);
});

test('stored payment ID cannot be overwritten while confirmation timestamp is absent', async () => {
  const setup = harness({ job: { razorpayPaymentId: 'pay_DIFFERENT', paymentConfirmedAt: null } });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, 'pay_DIFFERENT');
  assert.equal(job.paymentConfirmedAt, null);
  assert.equal(job.status, 'awaiting_payment');
  assert.equal(setup.calls.invoice.length, 0);
  assert.equal(setup.calls.dispatch.length, 0);
});

test('matching stored payment ID resumes a missing confirmation marker', async () => {
  const setup = harness({ job: { razorpayPaymentId: 'pay_PAYMENT1', paymentConfirmedAt: null } });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(job.paymentConfirmedAt.toMillis(), now);
  assert.equal(job.status, 'pending_offer');
  assert.deepEqual(setup.calls.invoice, ['job-1']);
  assert.deepEqual(setup.calls.dispatch, ['job-1']);
});

test('matching payment identity resumes a missing confirmation after status advancement', async () => {
  const setup = harness({
    job: {
      status: 'pending_offer',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: null,
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(job.paymentConfirmedAt.toMillis(), now);
});

test('advanced payment state without any identity or confirmation fails closed', async () => {
  const setup = harness({
    job: { status: 'pending_offer', razorpayPaymentId: null, paymentConfirmedAt: null },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, null);
  assert.equal(job.paymentConfirmedAt, null);
  assert.equal(setup.calls.invoice.length, 0);
});

test('payment confirmation without a stored payment ID fails closed', async () => {
  const setup = harness({
    job: {
      status: 'pending_offer',
      razorpayPaymentId: null,
      paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(setup.db.read('jobs', 'job-1').razorpayPaymentId, null);
  assert.equal(setup.calls.invoice.length, 0);
  assert.equal(setup.calls.dispatch.length, 0);
});

test('malformed payment confirmation timestamp fails closed without recovery side effects', async () => {
  const setup = harness({
    job: {
      status: 'pending_offer',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: 'not-a-timestamp',
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(setup.db.read('jobs', 'job-1').paymentConfirmedAt, 'not-a-timestamp');
  assert.equal(setup.calls.invoice.length, 0);
  assert.equal(setup.calls.dispatch.length, 0);
});

test('matching complete payment markers resume recovery work without rewriting identity', async () => {
  const confirmedAt = FakeTimestamp.fromMillis(now - 1000);
  const setup = harness({
    job: {
      status: 'pending_offer',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: confirmedAt,
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(job.paymentConfirmedAt.toMillis(), confirmedAt.toMillis());
  assert.deepEqual(setup.calls.invoice, ['job-1']);
  assert.deepEqual(setup.calls.dispatch, ['job-1']);
});

test('retry repairs an unambiguous legacy paid customer cancellation missing cancelledBy', async () => {
  const setup = harness({
    job: {
      status: 'cancelled_customer',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
      cancellationReason: 'customer_requested',
      cancelledBy: null,
    },
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.cancelledBy, 'customer');
  assert.equal(job.cancellationReason, 'customer_requested');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(setup.calls.invoice.length, 1);
  assert.equal(setup.calls.dispatch.length, 0);
});

test('corrupt invoice completion markers keep the paid webhook retryable instead of acknowledging success', async () => {
  const db = new FakeFirestore();
  seedAwaiting(db, {
    invoiceNumber: 'TDS-0001',
    invoiceIssueDateIst: '2027-01-15',
    invoiceIssuedAt: FakeTimestamp.fromMillis(now - 1000),
    invoiceStoragePath: null,
    invoiceUrl: null,
    invoiceWhatsAppMediaId: 'media-existing',
    invoiceWhatsAppMessageId: 'wamid.existing',
    invoiceSentAt: FakeTimestamp.fromMillis(now - 500),
  });
  db.seed('business_config', 'main', {
    businessName: 'Navi Mumbai Towing',
    gstin: '27ABCDE1234F1Z5',
    registeredAddress: 'Navi Mumbai, Maharashtra',
    invoiceNumberCounter: 1,
  });
  const invoice = createInvoiceService({
    db,
    storage: new FakeStorage(),
    TimestampClass: FakeTimestamp,
    now: () => new Date(now),
    whatsapp: {
      uploadDocument: async () => assert.fail('corrupt completed invoice must not upload'),
      sendDocumentByMediaId: async () => assert.fail('corrupt completed invoice must not send'),
    },
  });
  const webhook = createRazorpayWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { RAZORPAY_WEBHOOK_SECRET: 'webhook-secret' },
    verifySignatureFn: () => true,
    invoice,
    dispatch: { triggerDispatch: async () => ({ dispatched: false }) },
  });
  const res = createMockResponse();
  await webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  const job = db.read('jobs', 'job-1');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.ok(job.paymentConfirmedAt);
  assert.equal(db.read('processed_requests', 'razorpay:payment_link.paid:pay_PAYMENT1'), undefined);
});

test('signed unsupported events are intentionally acknowledged but malformed paid events are not', async () => {
  const setup = harness();
  const ignored = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request({ event: 'payment_link.cancelled' }), ignored);
  assert.equal(ignored.statusCode, 200);
  const malformed = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request({ event: 'payment_link.paid', payload: {} }), malformed);
  assert.equal(malformed.statusCode, 400);
});
