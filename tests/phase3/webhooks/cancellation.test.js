'use strict';

const { FakeFirestore, FakeTimestamp, createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppWebhook } = require('../../../firebase/functions/src/messaging/whatsappWebhook');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');

const phone = '+919876543210';
const now = 1_800_000_000_000;
const cancelMessage = { id: 'cancel-1', from: '919876543210', type: 'text', text: { body: 'CANCEL' } };

function link(status = 'created') {
  return {
    id: 'plink_JOB1', reference_id: 'job-1', currency: 'INR', amount: 50000,
    amount_paid: status === 'paid' ? 50000 : 0, accept_partial: false, status,
    short_url: 'https://rzp.io/i/job1',
  };
}

function setupCancellation({ job = {}, razorpay = {} } = {}) {
  const db = new FakeFirestore();
  db.seed('jobs', 'job-1', {
    customerPhone: phone,
    status: 'awaiting_payment',
    bookingFeePaise: 50000,
    razorpayPaymentLinkId: null,
    razorpayPaymentLinkUrl: null,
    razorpayPaymentId: null,
    paymentConfirmedAt: null,
    cancellationRequestedAt: null,
    cancelledBy: null,
    cancellationReason: null,
    ...job,
  });
  db.seed('whatsapp_sessions', phone, {
    phoneNumber: phone, state: 5, pickupCoords: { lat: 19, lng: 73 },
    destCoords: { lat: 19.1, lng: 73.1 }, requestedTruckType: 'flatbed', jobId: 'job-1',
    pendingReply: null, lastProcessedMessageId: null,
  });
  const calls = { list: 0, get: 0, cancel: 0, sent: [] };
  const provider = {
    getPaymentLinksByReferenceId: async jobId => {
      calls.list += 1;
      return razorpay.list ? razorpay.list(db, jobId) : [link('created')];
    },
    getPaymentLink: async id => {
      calls.get += 1;
      return razorpay.get ? razorpay.get(db, id) : link('created');
    },
    cancelPaymentLink: async id => {
      calls.cancel += 1;
      return razorpay.cancel ? razorpay.cancel(db, id) : link('cancelled');
    },
  };
  const webhook = createWhatsAppWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { WHATSAPP_VERIFY_TOKEN: 'verify', WHATSAPP_APP_SECRET: 'secret' },
    verifySignatureFn: () => true,
    jobs: { createJobAndQuote: async () => assert.fail('cancel must not create a job') },
    whatsapp: { sendText: async (...args) => { calls.sent.push(args); return { messageId: 'out-1' }; } },
    razorpay: provider,
  });
  return { db, webhook, calls, provider };
}

test('pre-payment cancellation persists marker before provider call and recovers missing local link', async () => {
  const setup = setupCancellation({
    razorpay: {
      list: db => {
        const job = db.read('jobs', 'job-1');
        assert.ok(job.cancellationRequestedAt);
        assert.equal(job.status, 'awaiting_payment');
        return [link('created')];
      },
    },
  });
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1');
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.cancelledBy, 'customer');
  assert.equal(job.cancellationReason, 'customer_requested');
  assert.equal(job.razorpayPaymentLinkId, 'plink_JOB1');
  assert.equal(job.razorpayPaymentId, null);
  assert.equal('razorpayRefundId' in job, false);
  const session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 1);
  assert.equal(session.jobId, null);
  assert.equal(session.pendingReply, null);
  assert.equal(session.lastProcessedMessageId, 'cancel-1');
  assert.equal(setup.calls.cancel, 1);
});

test('transient provider failure leaves cancellation marker and pending work recoverable', async () => {
  let failure = true;
  const setup = setupCancellation({
    razorpay: {
      list: () => {
        if (failure) throw new Error('Razorpay unavailable');
        return [link('cancelled')];
      },
    },
  });
  await assert.rejects(
    setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1'),
    /Razorpay unavailable/
  );
  let job = setup.db.read('jobs', 'job-1');
  assert.ok(job.cancellationRequestedAt);
  assert.equal(job.status, 'awaiting_payment');
  assert.equal(setup.db.read('whatsapp_sessions', phone).pendingReply.kind, 'cancel_unpaid');
  failure = false;
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-2');
  job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
});

test('missing remote link never falsely finalizes cancellation', async () => {
  const setup = setupCancellation({ razorpay: { list: () => [] } });
  await assert.rejects(
    setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1'),
    /No Razorpay Payment Link/
  );
  assert.equal(setup.db.read('jobs', 'job-1').status, 'awaiting_payment');
  assert.ok(setup.db.read('jobs', 'job-1').cancellationRequestedAt);
  assert.equal(setup.calls.sent.length, 0);
});

test('CANCEL then PAYMENT records payment, keeps cancellation, invoices, and never dispatches', async () => {
  const setup = setupCancellation({ razorpay: { list: () => [link('paid')] } });
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1');
  assert.equal(setup.db.read('jobs', 'job-1').status, 'awaiting_payment');
  assert.ok(setup.db.read('jobs', 'job-1').cancellationRequestedAt);

  const calls = { invoice: 0, dispatch: 0 };
  const payment = createRazorpayWebhook({
    db: setup.db,
    TimestampClass: FakeTimestamp,
    now: () => now + 1,
    env: { RAZORPAY_WEBHOOK_SECRET: 'secret' },
    verifySignatureFn: () => true,
    invoice: { ensureInvoiceAndSend: async () => { calls.invoice += 1; } },
    dispatch: { triggerDispatch: async () => { calls.dispatch += 1; } },
  });
  const body = {
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: link('paid') },
      payment: { entity: { id: 'pay_PAYMENT1', currency: 'INR', status: 'captured', amount: 50000 } },
    },
  };
  const res = createMockResponse();
  await payment.handleRazorpayWebhook({
    method: 'POST', rawBody: Buffer.from(JSON.stringify(body)), body,
    headers: { 'x-razorpay-signature': 'valid' },
  }, res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.cancelledBy, 'customer');
  assert.equal(job.cancellationReason, 'customer_requested');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.ok(job.paymentConfirmedAt);
  assert.equal(job.razorpayRefundId, undefined);
  assert.equal(calls.invoice, 1);
  assert.equal(calls.dispatch, 0);

  let session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 1);
  assert.equal(session.jobId, null);
  assert.equal(session.pendingReply, null);
  const nextMessage = {
    id: 'after-paid-cancellation',
    from: '919876543210',
    type: 'text',
    text: { body: 'hello' },
  };
  await setup.webhook.processMessage(phone, nextMessage, nextMessage.id, 'owner-next');
  session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 1);
  assert.equal(session.jobId, null);
  assert.equal(session.lastProcessedMessageId, nextMessage.id);
  assert.match(setup.calls.sent.at(-1)[1], /PICKUP location/);
});

test('PAYMENT then CANCEL preserves payment and directly cancels pending_offer without Razorpay refund', async () => {
  const setup = setupCancellation({
    job: {
      status: 'pending_offer',
      razorpayPaymentLinkId: 'plink_JOB1',
      razorpayPaymentLinkUrl: 'https://rzp.io/i/job1',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1),
    },
  });
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1');
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.razorpayPaymentId, 'pay_PAYMENT1');
  assert.equal(job.paymentConfirmedAt.toMillis(), now - 1);
  assert.equal(setup.calls.cancel, 0);
  assert.equal(setup.calls.get, 0);
  assert.equal(setup.calls.list, 0);
  assert.equal('razorpayRefundId' in job, false);
});

test('offered cancellation records Phase 4 marker without rewriting job state', async () => {
  const setup = setupCancellation({
    job: {
      status: 'offered',
      razorpayPaymentId: 'pay_PAYMENT1',
      paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1),
    },
  });
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1');
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.status, 'offered');
  assert.equal(job.cancelledBy, 'customer');
  assert.ok(job.cancellationRequestedAt);
  assert.equal(setup.db.read('whatsapp_sessions', phone).jobId, 'job-1');
});

test('completed cancellation does not corrupt completed-job audit fields', async () => {
  const completedAt = FakeTimestamp.fromMillis(now - 10_000);
  const setup = setupCancellation({
    job: {
      status: 'completed',
      completedAt,
      cancelledBy: null,
      cancellationRequestedAt: null,
    },
  });
  const before = setup.db.read('jobs', 'job-1');
  await setup.webhook.processMessage(phone, cancelMessage, 'cancel-1', 'owner-1');
  const after = setup.db.read('jobs', 'job-1');
  assert.deepEqual(after, before);
  assert.match(setup.calls.sent[0][1], /already completed/);
});
