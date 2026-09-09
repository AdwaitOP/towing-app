'use strict';

const { FakeFirestore, FakeTimestamp, createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function request(body = refundPayload(), secret = 'secret') {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    method: 'POST',
    rawBody,
    body,
    headers: { 'x-razorpay-signature': signature },
    get(name) {
      if (name.toLowerCase() === 'x-razorpay-signature') return signature;
      return this.headers[name] || this.headers[name.toLowerCase()];
    },
  };
}

function harness(jobOverrides = {}, refundOverrides = {}) {
  const db = new FakeFirestore();
  db.seed('jobs', 'job-1', {
    status: 'cancelled_system',
    dispatchState: 'closed',
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    bookingFeePaise: 50000,
    razorpayPaymentId: 'pay_PAYMENT1',
    paymentConfirmedAt: FakeTimestamp.fromMillis(now - 1000),
    refundRequestId: 'job-1',
    refundState: 'submitted',
    refundNextAttemptAt: FakeTimestamp.fromMillis(now + 30000),
    razorpayRefundId: 'rfnd_REFUND1',
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    ...jobOverrides,
  });
  if (refundOverrides !== null) {
    const defaultHash = crypto.createHash('sha256').update(JSON.stringify({
      paymentId: 'pay_PAYMENT1',
      amount: 50000,
    }), 'utf8').digest('hex');

    db.seed('refund_requests', 'job-1', {
      operationId: 'job-1',
      jobId: 'job-1',
      razorpayPaymentId: 'pay_PAYMENT1',
      amountPaise: 50000,
      reason: 'no_driver_found',
      providerIdempotencyKey: 'refund_no_driver_found_job-1',
      providerRequestHash: defaultHash,
      state: 'submitted',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      reconciliationNextAttemptAt: FakeTimestamp.fromMillis(now + 30000),
      reconciliationAttempts: 0,
      razorpayRefundId: 'rfnd_REFUND1',
      confirmationSource: null,
      attemptCount: 1,
      lastErrorCode: null,
      createdAt: FakeTimestamp.fromMillis(now - 1000),
      updatedAt: FakeTimestamp.fromMillis(now - 1000),
      submittedAt: FakeTimestamp.fromMillis(now - 500),
      confirmedAt: null,
      ...refundOverrides,
    });
  }
  const webhook = createRazorpayWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { RAZORPAY_WEBHOOK_SECRET: 'secret' },
    invoice: { ensureInvoiceAndSend: async () => assert.fail('refund must not invoice') },
    dispatch: { triggerDispatch: async () => assert.fail('refund must not dispatch') },
  });
  return { db, webhook };
}

test('refund.processed persists actual production fields under refund-ID identity and converges dual documents', async () => {
  const setup = harness();
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');
  assert.equal(job.refundState, 'confirmed');
  assert.equal(job.refundedAmountPaise, 50000);
  assert.equal(job.refundConfirmedAt.toMillis(), now);

  const refund = setup.db.read('refund_requests', 'job-1');
  assert.equal(refund.state, 'confirmed');
  assert.equal(refund.confirmationSource, 'webhook');
  assert.equal(refund.razorpayRefundId, 'rfnd_REFUND1');
  assert.equal(refund.confirmedAt.toMillis(), now);

  assert.equal(
    setup.db.read('processed_requests', 'razorpay:refund.processed:rfnd_REFUND1').status,
    'completed'
  );

  const outbox = setup.db.read('notification_outbox', 'refund_confirmed:job-1');
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'refund_confirmed:job-1');
  assert.equal(outbox.eventType, 'refund_confirmed');
  assert.equal(outbox.resourceType, 'refund_request');
  assert.equal(outbox.resourceId, 'job-1');
  assert.equal(outbox.channel, 'whatsapp');
  assert.equal(outbox.recipientKey, 'customer:job-1');
  assert.equal(outbox.payloadVersion, 1);
  assert.deepEqual(outbox.payload, {
    jobId: 'job-1',
    jobStatus: 'cancelled_system',
    refundAmountPaise: 50000,
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.ownerToken, null);
  assert.equal(outbox.leaseUntil, null);
  assert.equal(outbox.nextAttemptAt.toMillis(), now);
  assert.equal(outbox.attemptCount, 0);
  assert.equal(outbox.providerMessageId, null);
  assert.equal(outbox.lastErrorCode, null);
  assert.equal(outbox.createdAt.toMillis(), now);
  assert.equal(outbox.updatedAt.toMillis(), now);
  assert.equal(outbox.sentAt, null);
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
  }, {
    submittedAt: confirmedAt,
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
  assert.equal(corruptPayment.db.read('jobs', 'job-1').razorpayRefundId, 'rfnd_REFUND1');
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
  assert.equal(setup.db.read('jobs', 'job-1').razorpayRefundId, 'rfnd_REFUND1');
});

test('early unbound refund.processed returns 500, performs 0 writes, and deletes processed_requests claim', async () => {
  const setup = harness({ razorpayRefundId: null }, { razorpayRefundId: null, state: 'in_progress' });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 500);

  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.razorpayRefundId, null);
  assert.equal(job.refundState, 'submitted');

  const refund = setup.db.read('refund_requests', 'job-1');
  assert.equal(refund.razorpayRefundId, null);
  assert.equal(refund.state, 'in_progress');

  const processed = setup.db.read('processed_requests', 'razorpay:refund.processed:rfnd_REFUND1');
  assert.equal(processed, undefined);
});

test('late exact webhook converges failed_terminal to confirmed', async () => {
  const setup = harness({
    refundState: 'failed_terminal',
    refundNextAttemptAt: null,
    razorpayRefundId: 'rfnd_REFUND1',
  }, {
    state: 'failed_terminal',
    razorpayRefundId: 'rfnd_REFUND1',
    nextAttemptAt: null,
    reconciliationNextAttemptAt: null,
    lastErrorCode: 'PROVIDER_TIMEOUT',
    attemptCount: 1,
  });
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(), res);
  assert.equal(res.statusCode, 200);

  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.refundState, 'confirmed');
  assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');

  const refund = setup.db.read('refund_requests', 'job-1');
  assert.equal(refund.state, 'confirmed');
  assert.equal(refund.confirmationSource, 'webhook');
});

test('refund.failed webhook is ignored with 200 and zero state mutation', async () => {
  const setup = harness();
  const failedBody = {
    event: 'refund.failed',
    payload: { refund: { entity: {
      id: 'rfnd_REFUND1', payment_id: 'pay_PAYMENT1', status: 'failed',
      currency: 'INR', amount: 50000,
    } } },
  };
  const req = request(failedBody);
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(req, res);
  assert.equal(res.statusCode, 200);

  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.refundState, 'submitted');

  const refund = setup.db.read('refund_requests', 'job-1');
  assert.equal(refund.state, 'submitted');
});

function validOutboxRecord(state = 'pending', overrides = {}) {
  const base = {
    eventId: 'refund_confirmed:job-1',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job-1',
    channel: 'whatsapp',
    recipientKey: 'customer:job-1',
    payloadVersion: 1,
    payload: {
      jobId: 'job-1',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 50000,
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: FakeTimestamp.fromMillis(now),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: FakeTimestamp.fromMillis(now - 10000),
    updatedAt: FakeTimestamp.fromMillis(now - 10000),
    sentAt: null,
  };
  if (state === 'in_progress') {
    return {
      ...base,
      state: 'in_progress',
      ownerToken: 'worker-token-xyz',
      leaseUntil: FakeTimestamp.fromMillis(now + 60000),
      attemptCount: 1,
      ...overrides,
    };
  }
  if (state === 'retry_wait') {
    return {
      ...base,
      state: 'retry_wait',
      attemptCount: 1,
      nextAttemptAt: FakeTimestamp.fromMillis(now + 30000),
      lastErrorCode: 'provider_unavailable',
      ...overrides,
    };
  }
  if (state === 'sent') {
    return {
      ...base,
      state: 'sent',
      attemptCount: 1,
      sentAt: FakeTimestamp.fromMillis(now - 5000),
      updatedAt: FakeTimestamp.fromMillis(now - 5000),
      providerMessageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
      ...overrides,
    };
  }
  if (state === 'failed_terminal') {
    return {
      ...base,
      state: 'failed_terminal',
      attemptCount: 5,
      lastErrorCode: 'internal_error',
      updatedAt: FakeTimestamp.fromMillis(now - 5000),
      ...overrides,
    };
  }
  return { ...base, ...overrides };
}

for (const state of ['pending', 'in_progress', 'retry_wait', 'sent', 'failed_terminal']) {
  test(`refund.processed preserves existing ${state} notification_outbox without resetting delivery fields`, async () => {
    const setup = harness();
    const seededOutbox = validOutboxRecord(state);
    setup.db.seed('notification_outbox', 'refund_confirmed:job-1', seededOutbox);

    const res = createMockResponse();
    await setup.webhook.handleRazorpayWebhook(request(), res);
    assert.equal(res.statusCode, 200);

    const outboxAfter = setup.db.read('notification_outbox', 'refund_confirmed:job-1');
    assert.deepEqual(outboxAfter, seededOutbox);
  });
}

const corruptMutations = [
  { name: 'extra root key', mutate: o => { o.extraField = 'bad'; } },
  { name: 'missing root key (sentAt)', mutate: o => { delete o.sentAt; } },
  { name: 'missing root key (attemptCount)', mutate: o => { delete o.attemptCount; } },
  { name: 'wrong eventId', mutate: o => { o.eventId = 'refund_confirmed:other-job'; } },
  { name: 'wrong eventType', mutate: o => { o.eventType = 'job_confirmed'; } },
  { name: 'wrong resourceType', mutate: o => { o.resourceType = 'job'; } },
  { name: 'wrong resourceId', mutate: o => { o.resourceId = 'other-job'; } },
  { name: 'wrong channel', mutate: o => { o.channel = 'sms'; } },
  { name: 'wrong recipientKey', mutate: o => { o.recipientKey = 'customer:other-job'; } },
  { name: 'raw phone in recipientKey', mutate: o => { o.recipientKey = '+919876543210'; } },
  { name: 'wrong payloadVersion', mutate: o => { o.payloadVersion = 2; } },
  { name: 'missing payload key (refundAmountPaise)', mutate: o => { delete o.payload.refundAmountPaise; } },
  { name: 'extra payload key (customerPhone)', mutate: o => { o.payload.customerPhone = '+919876543210'; } },
  { name: 'wrong payload jobId', mutate: o => { o.payload.jobId = 'other-job'; } },
  { name: 'wrong payload jobStatus', mutate: o => { o.payload.jobStatus = 'accepted'; } },
  { name: 'wrong payload refundAmountPaise', mutate: o => { o.payload.refundAmountPaise = 100; } },
  { name: 'null payload refundAmountPaise', mutate: o => { o.payload.refundAmountPaise = null; } },
  { name: 'unknown state enum', mutate: o => { o.state = 'completed'; } },
  { name: 'pending with non-zero attemptCount', mutate: o => { o.attemptCount = 1; } },
  { name: 'pending with non-null ownerToken', mutate: o => { o.ownerToken = 'tok'; } },
  { name: 'pending with non-null leaseUntil', mutate: o => { o.leaseUntil = FakeTimestamp.fromMillis(now); } },
  { name: 'pending with non-null providerMessageId', mutate: o => { o.providerMessageId = 'wamid.123'; } },
  { name: 'pending with non-null sentAt', mutate: o => { o.sentAt = FakeTimestamp.fromMillis(now); } },
  { name: 'pending with non-null lastErrorCode', mutate: o => { o.lastErrorCode = 'internal_error'; } },
  { name: 'in_progress with zero attemptCount', state: 'in_progress', mutate: o => { o.attemptCount = 0; } },
  { name: 'in_progress with null ownerToken', state: 'in_progress', mutate: o => { o.ownerToken = null; } },
  { name: 'in_progress with null leaseUntil', state: 'in_progress', mutate: o => { o.leaseUntil = null; } },
  { name: 'in_progress with non-null sentAt', state: 'in_progress', mutate: o => { o.sentAt = FakeTimestamp.fromMillis(now); } },
  { name: 'retry_wait with non-null ownerToken', state: 'retry_wait', mutate: o => { o.ownerToken = 'tok'; } },
  { name: 'retry_wait with null lastErrorCode', state: 'retry_wait', mutate: o => { o.lastErrorCode = null; } },
  { name: 'retry_wait with invalid error code enum', state: 'retry_wait', mutate: o => { o.lastErrorCode = 'unknown_code'; } },
  { name: 'sent with null sentAt', state: 'sent', mutate: o => { o.sentAt = null; } },
  { name: 'sent with non-null ownerToken', state: 'sent', mutate: o => { o.ownerToken = 'tok'; } },
  { name: 'sent with null providerMessageId', state: 'sent', mutate: o => { o.providerMessageId = null; } },
  { name: 'sent with non-null lastErrorCode', state: 'sent', mutate: o => { o.lastErrorCode = 'internal_error'; } },
  { name: 'failed_terminal with null lastErrorCode', state: 'failed_terminal', mutate: o => { o.lastErrorCode = null; } },
  { name: 'failed_terminal with non-null ownerToken', state: 'failed_terminal', mutate: o => { o.ownerToken = 'tok'; } },
  { name: 'failed_terminal with invalid lastErrorCode enum', state: 'failed_terminal', mutate: o => { o.lastErrorCode = 'not_allowed_error'; } },
  { name: 'non-timestamp createdAt', mutate: o => { o.createdAt = 'not-a-timestamp'; } },
  { name: 'non-timestamp updatedAt', mutate: o => { o.updatedAt = 123456789; } },
  { name: 'attemptCount = 1.5', mutate: o => { o.attemptCount = 1.5; } },
  { name: 'attemptCount = NaN', mutate: o => { o.attemptCount = NaN; } },
  { name: 'attemptCount = Infinity', mutate: o => { o.attemptCount = Infinity; } },
  { name: 'unsafe attemptCount', mutate: o => { o.attemptCount = Number.MAX_SAFE_INTEGER + 100; } },
  { name: 'in_progress + lastErrorCode non-null when forbidden', state: 'in_progress', mutate: o => { o.lastErrorCode = 'not_allowed_error'; } },
  { name: 'in_progress + invalid nextAttemptAt type', state: 'in_progress', mutate: o => { o.nextAttemptAt = 'invalid_timestamp'; } },
  { name: 'sent + invalid nextAttemptAt type', state: 'sent', mutate: o => { o.nextAttemptAt = 987654321; } },
  { name: 'failed_terminal + providerMessageId non-null when forbidden', state: 'failed_terminal', mutate: o => { o.providerMessageId = 'wamid.123'; } },
  { name: 'invalid createdAt/updatedAt ordering', mutate: o => { o.createdAt = FakeTimestamp.fromMillis(now + 10000); o.updatedAt = FakeTimestamp.fromMillis(now); } },
];

for (const m of corruptMutations) {
  test(`refund.processed rejects corrupt notification_outbox (${m.name}) with 500 and zero writes`, async () => {
    const setup = harness();
    const outbox = validOutboxRecord(m.state || 'pending');
    m.mutate(outbox);
    setup.db.seed('notification_outbox', 'refund_confirmed:job-1', outbox);

    const res = createMockResponse();
    await setup.webhook.handleRazorpayWebhook(request(), res);
    assert.equal(res.statusCode, 500);

    const job = setup.db.read('jobs', 'job-1');
    assert.equal(job.refundState, 'submitted');
    assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');

    const refund = setup.db.read('refund_requests', 'job-1');
    assert.equal(refund.state, 'submitted');
    assert.equal(refund.confirmedAt, null);

    const outboxAfter = setup.db.read('notification_outbox', 'refund_confirmed:job-1');
    assert.deepEqual(outboxAfter, outbox);
  });
}

test('signed refund.failed webhook returns 200 ignored with zero domain writes and no outbox write', async () => {
  const setup = harness();
  const failedBody = {
    event: 'refund.failed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_FAILED1',
          payment_id: 'pay_PAYMENT1',
          amount: 50000,
          status: 'failed',
        },
      },
    },
  };
  const res = createMockResponse();
  await setup.webhook.handleRazorpayWebhook(request(failedBody), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'Event ignored');

  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.refundState, 'submitted');
  assert.equal(job.razorpayRefundId, 'rfnd_REFUND1');
  assert.equal(job.refundConfirmedAt, null);

  const refund = setup.db.read('refund_requests', 'job-1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.confirmedAt, null);

  const outbox = setup.db.read('notification_outbox', 'refund_confirmed:job-1');
  assert.equal(outbox, undefined);
});
