'use strict';

const { FakeFirestore, FakeTimestamp, createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');

const now = 1_800_000_000_000;

function refundPayload(overrides = {}) {
  return {
    event: 'refund.processed',
    payload: { refund: { entity: {
      id: 'rfnd_REFUND1', payment_id: 'pay_PAYMENT1', status: 'processed',
      currency: 'INR', amount: 50000, ...overrides,
    } } },
  };
}

function request(body = refundPayload()) {
  return {
    method: 'POST', rawBody: Buffer.from(JSON.stringify(body)), body,
    headers: { 'x-razorpay-signature': 'valid' },
  };
}

function harness(jobOverrides = {}) {
  const db = new FakeFirestore();
  db.seed('jobs', 'job-1', {
    status: 'cancelled_system',
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    bookingFeePaise: 50000,
    razorpayPaymentId: 'pay_PAYMENT1',
    paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
    razorpayRefundId: null,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    ...jobOverrides,
  });
  const webhook = createRazorpayWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { RAZORPAY_WEBHOOK_SECRET: 'secret' },
    verifySignatureFn: () => true,
    invoice: { ensureInvoiceAndSend: async () => assert.fail('refund must not invoice') },
    dispatch: { triggerDispatch: async () => assert.fail('refund must not dispatch') },
  });
  return { db, webhook };
}

test('refund.processed persists actual production fields under refund-ID identity', async () => {
  const setup = harness();
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');
  assert.equal(job.refundedAmountPaise, 50000);
  assert.equal(job.refundConfirmedAt.toMillis(), now);
  assert.equal(
    setup.db.read('processed_requests', 'razorpay:refund.processed:rfnd_REFUND1').status,
    'completed'
  );
});

test('duplicate matching refund is idempotent while a different stored refund is rejected', async () => {
  const setup = harness();
  await setup.webhook.handleRazorpayWebhook(request(), createMockResponse());
  const duplicate = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), duplicate);
  assert.equal(duplicate.statusCode, 200);

  const mismatch = harness({
    razorpayRefundId: 'rfnd_OTHER', refundedAmountPaise: 50000,
    refundConfirmedAt: FakeTimestamp.fromMillis(now - 1),
  });
  const res = createMockResponse();
  await mismatch.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(mismatch.db.read('jobs', 'job-1').razorpayRefundId, 'rfnd_OTHER');
});

test('matching refund ID safely completes missing amount and confirmation markers', async () => {
  const setup = harness({
    razorpayRefundId: 'rfnd_REFUND1',
    refundedAmountPaise: null,
    refundConfirmedAt: null,
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');
  assert.equal(job.refundedAmountPaise, 50000);
  assert.equal(job.refundConfirmedAt.toMillis(), now);
});

test('matching refund ID and amount safely resume a missing confirmation marker', async () => {
  const setup = harness({
    razorpayRefundId: 'rfnd_REFUND1',
    refundedAmountPaise: 50000,
    refundConfirmedAt: null,
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(setup.db.read('jobs', 'job-1').refundConfirmedAt.toMillis(), now);
});

test('matching refund identity preserves an existing confirmation while repairing a missing amount', async () => {
  const confirmedAt = FakeTimestamp.fromMillis(now - 1000);
  const setup = harness({
    razorpayRefundId: 'rfnd_REFUND1',
    refundedAmountPaise: null,
    refundConfirmedAt: confirmedAt,
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.refundedAmountPaise, 50000);
  assert.equal(job.refundConfirmedAt.toMillis(), confirmedAt.toMillis());
});

test('refund markers without identity or with contradictory amount fail closed', async () => {
  for (const partial of [
    { razorpayRefundId: null, refundedAmountPaise: 50000, refundConfirmedAt: null },
    {
      razorpayRefundId: null,
      refundedAmountPaise: null,
      refundConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
    },
    { razorpayRefundId: 'rfnd_REFUND1', refundedAmountPaise: 49999, refundConfirmedAt: null },
    { razorpayRefundId: 'rfnd_OTHER', refundedAmountPaise: null, refundConfirmedAt: null },
    { razorpayRefundId: 'rfnd_REFUND1', refundedAmountPaise: 50000, refundConfirmedAt: 'invalid' },
  ]) {
    const setup = harness(partial);
    const before = setup.db.read('jobs', 'job-1');
    const res = createMockResponse();
    await setup.webhook.handleRazorpayWebhook(request(), res);
    assert.equal(res.statusCode, 500);
    const after = setup.db.read('jobs', 'job-1');
    assert.equal(after.razorpayRefundId, before.razorpayRefundId);
    assert.equal(after.refundedAmountPaise, before.refundedAmountPaise);
    assert.deepEqual(after.refundConfirmedAt, before.refundConfirmedAt);
  }
});

test('refund rejects wrong amount, payment, or non-system cancellation context', async () => {
  const wrongAmount = harness();
  const amountRes = createMockResponse();
  await wrongAmount.webhook.handleRazorpayWebhook(request(refundPayload({ amount: 49999 })), amountRes);
  assert.equal(amountRes.statusCode, 500);

  const wrongContext = harness({ status: 'cancelled_customer', cancelledBy: 'customer' });
  const contextRes = createMockResponse();
  await wrongContext.webhook.handleRazorpayWebhook(request(), contextRes);
  assert.equal(contextRes.statusCode, 500);

  const missingPayment = harness();
  const paymentRes = createMockResponse();
  await missingPayment.webhook.handleRazorpayWebhook(request(refundPayload({ payment_id: 'pay_UNKNOWN' })), paymentRes);
  assert.equal(paymentRes.statusCode, 500);

  const corruptPayment = harness({ paymentConfirmedAt: 'not-a-timestamp' });
  const corruptPaymentRes = createMockResponse();
  await corruptPayment.webhook.handleRazorpayWebhook(request(), corruptPaymentRes);
  assert.equal(corruptPaymentRes.statusCode, 500);
  assert.equal(corruptPayment.db.read('jobs', 'job-1').razorpayRefundId, null);
});

test('ambiguous jobs sharing a payment ID are rejected instead of updating an arbitrary match', async () => {
  const setup = harness();
  setup.db.seed('jobs', 'job-2', {
    status: 'cancelled_system', cancelledBy: 'system', cancellationReason: 'no_driver_found',
    bookingFeePaise: 50000, razorpayPaymentId: 'pay_PAYMENT1',
    paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(setup.db.read('jobs', 'job-1').razorpayRefundId, null);
});
