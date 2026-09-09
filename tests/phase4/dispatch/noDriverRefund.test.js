'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createNoDriverRefundManager,
  shouldProcessRefundIntent,
  classifyProviderError,
  calculateBackoffMs,
  calculateReconciliationBackoffMs,
} = require('../../../firebase/functions/src/dispatch/noDriverRefund');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');
const { createRazorpayClient, ProviderResponseError } = require('../../../firebase/functions/src/services/razorpayClient');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');

function setupHarness({
  nowMs = 1_000_000,
  jobPatch = {},
  refundPatch = {},
  provider = {},
} = {}) {
  const db = new FakeFirestore();
  const jobId = 'job_1';
  const paymentId = jobPatch.razorpayPaymentId || 'pay_TEST123';
  const amountPaise = jobPatch.bookingFeePaise !== undefined ? jobPatch.bookingFeePaise : 10000;

  const defaultHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId,
    amount: amountPaise,
  }), 'utf8').digest('hex');

  const refundState = refundPatch.state || 'pending';
  const isSubmitted = refundState === 'submitted' || jobPatch.refundState === 'submitted';
  const isInProgress = refundState === 'in_progress' || jobPatch.refundState === 'in_progress';
  const isConfirmed = refundState === 'confirmed' || jobPatch.refundState === 'confirmed';
  const isFailedTerminal = refundState === 'failed_terminal' || jobPatch.refundState === 'failed_terminal';
  const isRetryWait = refundState === 'retry_wait' || jobPatch.refundState === 'retry_wait';
  const defaultReconciliationDue = FakeTimestamp.fromMillis(nowMs);
  const defaultConfirmedAt = FakeTimestamp.fromMillis(nowMs - 500);

  const defaultNextAttempt = refundPatch.nextAttemptAt || FakeTimestamp.fromMillis(nowMs);
  const defaultJobState = isConfirmed ? 'confirmed' : (isFailedTerminal ? 'failed_terminal' : (isSubmitted ? 'submitted' : (isInProgress ? 'in_progress' : (isRetryWait ? 'retry_wait' : 'pending'))));
  const defaultRefundState = isConfirmed ? 'confirmed' : (isFailedTerminal ? 'failed_terminal' : (isSubmitted ? 'submitted' : (isInProgress ? 'in_progress' : (isRetryWait ? 'retry_wait' : 'pending'))));

  db.seed('jobs', jobId, {
    status: 'cancelled_system',
    dispatchState: 'closed',
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    cancelledAt: FakeTimestamp.fromMillis(nowMs - 1000),
    refundRequestId: jobId,
    refundState: defaultJobState,
    refundNextAttemptAt: isSubmitted ? defaultReconciliationDue : (isConfirmed || isFailedTerminal ? null : defaultNextAttempt),
    razorpayRefundId: (isSubmitted || isConfirmed) ? (refundPatch.razorpayRefundId || 'rfnd_SUCCESS12345') : null,
    refundConfirmedAt: isConfirmed ? defaultConfirmedAt : null,
    refundedAmountPaise: isConfirmed ? amountPaise : null,
    bookingFeePaise: amountPaise,
    razorpayPaymentId: paymentId,
    paymentConfirmedAt: FakeTimestamp.fromMillis(nowMs - 5000),
    ...jobPatch,
  });

  db.seed('refund_requests', jobId, {
    operationId: jobId,
    jobId,
    razorpayPaymentId: paymentId,
    amountPaise,
    reason: 'no_driver_found',
    providerIdempotencyKey: 'refund_no_driver_found_' + jobId,
    providerRequestHash: defaultHash,
    state: defaultRefundState,
    ownerToken: isInProgress ? (refundPatch.ownerToken || 'prior_token') : null,
    leaseUntil: isInProgress ? (refundPatch.leaseUntil || FakeTimestamp.fromMillis(nowMs + 60000)) : null,
    nextAttemptAt: (isSubmitted || isConfirmed || isFailedTerminal) ? null : defaultNextAttempt,
    reconciliationNextAttemptAt: isSubmitted ? defaultReconciliationDue : null,
    reconciliationAttempts: 0,
    razorpayRefundId: (isSubmitted || isConfirmed) ? (refundPatch.razorpayRefundId || 'rfnd_SUCCESS12345') : null,
    confirmationSource: isConfirmed ? (refundPatch.confirmationSource || 'webhook') : null,
    attemptCount: (isSubmitted || isInProgress || isRetryWait || isConfirmed || isFailedTerminal) ? (refundPatch.attemptCount || 1) : 0,
    lastErrorCode: isRetryWait ? (refundPatch.lastErrorCode || 'PROVIDER_UNAVAILABLE') : (isFailedTerminal ? (refundPatch.lastErrorCode || 'PROVIDER_TIMEOUT') : null),
    createdAt: FakeTimestamp.fromMillis(nowMs - 1000),
    updatedAt: FakeTimestamp.fromMillis(nowMs - 1000),
    submittedAt: (isSubmitted || isConfirmed) ? FakeTimestamp.fromMillis(nowMs - 500) : null,
    confirmedAt: isConfirmed ? defaultConfirmedAt : null,
    ...refundPatch,
  });

  const calls = { create: [], get: [] };

  const fakeClient = {
    createRefund: async args => {
      calls.create.push(args);
      if (typeof provider.createRefund === 'function') return provider.createRefund(args);
      return {
        id: 'rfnd_SUCCESS12345',
        entity: 'refund',
        amount: args.amount,
        currency: 'INR',
        payment_id: args.paymentId,
        status: 'pending',
      };
    },
    getRefund: async args => {
      calls.get.push(args);
      if (typeof provider.getRefund === 'function') return provider.getRefund(args);
      return {
        id: args.refundId,
        entity: 'refund',
        amount: args.amount || 10000,
        currency: 'INR',
        payment_id: args.paymentId,
        status: 'processed',
      };
    },
  };

  const manager = createNoDriverRefundManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
    razorpayClient: fakeClient,
  });

  const webhook = createRazorpayWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
    env: { RAZORPAY_WEBHOOK_SECRET: 'secret' },
    verifySignatureFn: () => true,
    invoice: { ensureInvoiceAndSend: async () => assert.fail('must not invoice') },
    dispatch: { triggerDispatch: async () => assert.fail('must not dispatch') },
  });

  return { db, jobId, manager, webhook, calls, nowMs, fakeClient };
}

// ── 1. Canonical Pending Claim ─────────────────────────────────────────────
test('1 canonical pending claim creates lease, increments attemptCount to 1, and calls provider', async () => {
  const { manager, db, jobId, calls } = setupHarness();
  const res = await manager.processRefundIntent(jobId);
  assert.equal(res.status, 'submitted');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].idempotencyKey, 'refund_no_driver_found_job_1');
  assert.equal(calls.create[0].amount, 10000);

  const refund = db.read('refund_requests', jobId);
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.attemptCount, 1);
  assert.equal(refund.ownerToken, null);
  assert.equal(refund.leaseUntil, null);
  assert.equal(refund.razorpayRefundId, 'rfnd_SUCCESS12345');

  const job = db.read('jobs', jobId);
  assert.equal(job.refundState, 'submitted');
  assert.equal(job.razorpayRefundId, 'rfnd_SUCCESS12345');
});

// ── 2-7. Validation Failures ───────────────────────────────────────────────
test('2 malformed job terminal state fails closed with zero provider contact', async () => {
  const { manager, calls } = setupHarness({ jobPatch: { status: 'pending_offer' } });
  await assert.rejects(manager.processRefundIntent('job_1'), /JOB_NOT_SYSTEM_CANCELLED/);
  assert.equal(calls.create.length, 0);
});

test('3 customer cancellation excluded fails closed with zero provider contact', async () => {
  const { manager, calls } = setupHarness({
    jobPatch: { status: 'cancelled_customer', cancelledBy: 'customer', cancellationReason: 'customer_requested' },
  });
  await assert.rejects(manager.processRefundIntent('job_1'), /JOB_NOT_SYSTEM_CANCELLED/);
  assert.equal(calls.create.length, 0);
});

test('4 wrong reason fails closed', async () => {
  const { manager, calls } = setupHarness({ jobPatch: { cancellationReason: 'customer_timeout' } });
  await assert.rejects(manager.processRefundIntent('job_1'), /JOB_NOT_SYSTEM_CANCELLED/);
  assert.equal(calls.create.length, 0);
});

test('5 refund amount mismatch fails closed', async () => {
  const { manager, calls } = setupHarness({ refundPatch: { amountPaise: 20000 } });
  await assert.rejects(manager.processRefundIntent('job_1'), /REFUND_AMOUNT_MISMATCH/);
  assert.equal(calls.create.length, 0);
});

test('6 missing payment ID fails closed', async () => {
  const { manager, calls } = setupHarness({ jobPatch: { razorpayPaymentId: '' } });
  await assert.rejects(manager.processRefundIntent('job_1'), /PAYMENT_ID_INVALID/);
  assert.equal(calls.create.length, 0);
});

test('7 unsafe / negative amount fails closed', async () => {
  const { manager, calls } = setupHarness({ jobPatch: { bookingFeePaise: -500 } });
  await assert.rejects(manager.processRefundIntent('job_1'), /REFUND_AMOUNT_INVALID/);
  assert.equal(calls.create.length, 0);
});

test('8 providerRequestHash mismatch fails closed', async () => {
  const { manager, calls } = setupHarness({ refundPatch: { providerRequestHash: 'corrupt_hash' } });
  await assert.rejects(manager.processRefundIntent('job_1'), /REQUEST_HASH_MISMATCH/);
  assert.equal(calls.create.length, 0);
});

test('9 providerIdempotencyKey mismatch fails closed', async () => {
  const { manager, calls } = setupHarness({ refundPatch: { providerIdempotencyKey: 'wrong_key' } });
  await assert.rejects(manager.processRefundIntent('job_1'), /IDEMPOTENCY_KEY_MISMATCH/);
  assert.equal(calls.create.length, 0);
});

// ── 10-12. Lease Boundaries ────────────────────────────────────────────────
test('10 active lease prevents concurrent claim', async () => {
  const testNowMs = 1000000;
  const { manager, calls } = setupHarness({
    nowMs: testNowMs,
    refundPatch: {
      state: 'in_progress',
      ownerToken: 'other_worker',
      leaseUntil: FakeTimestamp.fromMillis(testNowMs + 30000),
    },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'active_lease');
  assert.equal(calls.create.length, 0);
});

test('11 exact lease expiry boundary: now == leaseUntil is reclaimable', async () => {
  const testNowMs = 1000000;
  const { manager, calls } = setupHarness({
    nowMs: testNowMs,
    refundPatch: {
      state: 'in_progress',
      ownerToken: 'expired_worker',
      leaseUntil: FakeTimestamp.fromMillis(testNowMs),
    },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'submitted');
  assert.equal(calls.create.length, 1);
});

test('12 expired lease takeover: now > leaseUntil claims and increments attemptCount', async () => {
  const testNowMs = 1000000;
  const { manager, calls, db } = setupHarness({
    nowMs: testNowMs,
    refundPatch: {
      state: 'in_progress',
      ownerToken: 'stale_worker',
      leaseUntil: FakeTimestamp.fromMillis(testNowMs - 1000),
      attemptCount: 1,
    },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'submitted');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.attemptCount, 2);
  assert.equal(calls.create.length, 1);
});

// ── 13-15. Provider Success / Synch Fail Outcomes ─────────────────────────
test('13 provider success pending moves to submitted with initial reconciliation delay', async () => {
  const { manager, db, nowMs } = setupHarness({
    provider: {
      createRefund: async () => ({
        id: 'rfnd_PENDING1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'pending',
      }),
    },
  });
  await manager.processRefundIntent('job_1');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.razorpayRefundId, 'rfnd_PENDING1');
  assert.equal(refund.reconciliationNextAttemptAt.toMillis(), nowMs + 30000);
});

test('14 provider success processed moves to submitted, not confirmed (Option A)', async () => {
  const { manager, db } = setupHarness({
    provider: {
      createRefund: async () => ({
        id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
      }),
    },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'submitted');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.confirmationSource, null);
});

test('15 provider synchronous failed moves to failed_terminal directly', async () => {
  const { manager, db } = setupHarness({
    provider: {
      createRefund: async () => ({
        id: 'rfnd_FAIL1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'failed',
      }),
    },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'failed_terminal');
  assert.equal(refund.lastErrorCode, 'PROVIDER_REFUND_FAILED');
  assert.equal(refund.razorpayRefundId, 'rfnd_FAIL1');
  assert.equal(refund.nextAttemptAt, null);
});

// ── 16-22. Errors: 409, 429, 5xx, timeouts ────────────────────────────────
test('16 retryable timeout moves to retry_wait with backoff', async () => {
  const timeoutErr = new Error('Razorpay request timed out');
  timeoutErr.name = 'AbortError';
  const { manager, db, nowMs } = setupHarness({
    provider: { createRefund: async () => { throw timeoutErr; } },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.errorCode, 'PROVIDER_TIMEOUT');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'retry_wait');
  assert.equal(refund.nextAttemptAt.toMillis(), nowMs + 5000);
});

test('17 network failure moves to retry_wait with PROVIDER_NETWORK_ERROR', async () => {
  const netErr = new Error('fetch failed: ECONNREFUSED');
  const { manager, db } = setupHarness({
    provider: { createRefund: async () => { throw netErr; } },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.errorCode, 'PROVIDER_NETWORK_ERROR');
  assert.equal(db.read('refund_requests', 'job_1').state, 'retry_wait');
});

test('18 HTTP 429 rate limited moves to retry_wait', async () => {
  const err = new Error('Rate limited');
  err.status = 429;
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.errorCode, 'PROVIDER_RATE_LIMITED');
  assert.equal(db.read('refund_requests', 'job_1').state, 'retry_wait');
});

test('19 HTTP 500/502/503/504 moves to retry_wait with PROVIDER_UNAVAILABLE', async () => {
  for (const status of [500, 502, 503, 504]) {
    const err = new Error('Server error');
    err.status = status;
    const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
    const res = await manager.processRefundIntent('job_1');
    assert.equal(res.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(db.read('refund_requests', 'job_1').state, 'retry_wait');
  }
});

test('20 same-key-processing 409 moves to retry_wait with PROVIDER_PROCESSING_CONFLICT', async () => {
  const err = new Error('Another request with the same idempotency key is still in progress');
  err.status = 409;
  err.providerBody = { error: { description: 'Another request with the same idempotency key is still in progress' } };
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.errorCode, 'PROVIDER_PROCESSING_CONFLICT');
  assert.equal(db.read('refund_requests', 'job_1').state, 'retry_wait');
});

test('21 different-request/same-key 409 moves to failed_terminal with PROVIDER_IDEMPOTENCY_CONFLICT', async () => {
  const err = new Error('Different request with the same idempotency key has already been processed');
  err.status = 409;
  err.providerBody = { error: { description: 'Different request with the same idempotency key has already been processed' } };
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.errorCode, 'PROVIDER_IDEMPOTENCY_CONFLICT');
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'failed_terminal');
  assert.equal(refund.nextAttemptAt, null);
});

test('22 concurrent-operation retryable 400 moves to retry_wait with PROVIDER_CONCURRENT_MUTATION', async () => {
  const err = new Error('Another operation is in progress');
  err.status = 400;
  err.providerBody = { error: { description: 'Another operation is in progress on this payment' } };
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.errorCode, 'PROVIDER_CONCURRENT_MUTATION');
  assert.equal(db.read('refund_requests', 'job_1').state, 'retry_wait');
});

// ── 23-28. Permanent / Ambiguous Errors ─────────────────────────────────────
test('23 permanent bad request moves to failed_terminal with PROVIDER_BAD_REQUEST', async () => {
  const err = new Error('Bad request');
  err.status = 400;
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.errorCode, 'PROVIDER_BAD_REQUEST');
  assert.equal(db.read('refund_requests', 'job_1').state, 'failed_terminal');
});

test('24 authentication failure moves to failed_terminal with PROVIDER_AUTHENTICATION_ERROR', async () => {
  const err = new Error('Auth error');
  err.status = 401;
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.errorCode, 'PROVIDER_AUTHENTICATION_ERROR');
});

test('25 payment not found moves to failed_terminal with PROVIDER_PAYMENT_NOT_FOUND', async () => {
  const err = new Error('Not found');
  err.status = 404;
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.errorCode, 'PROVIDER_PAYMENT_NOT_FOUND');
});

test('26 amount exceeded moves to failed_terminal with PROVIDER_AMOUNT_EXCEEDED', async () => {
  const err = new Error('Amount exceeds refundable balance');
  err.status = 400;
  err.providerBody = { error: { description: 'Amount exceeds refundable amount' } };
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.errorCode, 'PROVIDER_AMOUNT_EXCEEDED');
});

test('27 already-fully-refunded ambiguous moves to retry_wait under attempt limit', async () => {
  const err = new Error('Fully refunded');
  err.status = 400;
  err.providerBody = { error: { description: 'Payment has already been fully refunded' } };
  const { manager, db } = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.errorCode, 'PROVIDER_ALREADY_REFUNDED_AMBIGUOUS');
  assert.equal(db.read('refund_requests', 'job_1').razorpayRefundId, null); // never adopted arbitrary ID
});

test('28 ambiguous condition eventually reaches attempt limit safely', async () => {
  const { manager, db } = setupHarness({
    refundPatch: { attemptCount: 5, state: 'retry_wait' },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.reason, 'max_attempts_exceeded');
  assert.equal(db.read('refund_requests', 'job_1').state, 'failed_terminal');
});

// ── 29-33. attemptCount & Backoff Invariants ──────────────────────────────
test('29-32 attemptCount only increments in Tx1 and remains constant in Tx2A, Tx2B, Tx2C', async () => {
  // Tx2A success:
  const hSuccess = setupHarness();
  await hSuccess.manager.processRefundIntent('job_1');
  assert.equal(hSuccess.db.read('refund_requests', 'job_1').attemptCount, 1);

  // Tx2B retry_wait:
  const err = new Error('Timeout');
  err.name = 'AbortError';
  const hRetry = setupHarness({ provider: { createRefund: async () => { throw err; } } });
  await hRetry.manager.processRefundIntent('job_1');
  assert.equal(hRetry.db.read('refund_requests', 'job_1').attemptCount, 1);

  // Tx2C failed_terminal:
  const errPerm = new Error('Bad request');
  errPerm.status = 400;
  const hFail = setupHarness({ provider: { createRefund: async () => { throw errPerm; } } });
  await hFail.manager.processRefundIntent('job_1');
  assert.equal(hFail.db.read('refund_requests', 'job_1').attemptCount, 1);
});

test('33 exact backoff formula: 5s, 10s, 20s, 40s, capped at 300s', () => {
  assert.equal(calculateBackoffMs(1), 5000);
  assert.equal(calculateBackoffMs(2), 10000);
  assert.equal(calculateBackoffMs(3), 20000);
  assert.equal(calculateBackoffMs(4), 40000);
  assert.equal(calculateBackoffMs(5), 80000);
  assert.equal(calculateBackoffMs(10), 300000);
});

// ── 34-41. Response Validation ─────────────────────────────────────────────
test('34-37 malformed provider response / wrong payment / amount / status fails closed', async () => {
  for (const badResp of [
    null,
    { entity: 'not_refund' },
    { entity: 'refund', id: 'bad', payment_id: 'pay_TEST123', amount: 10000, status: 'pending' },
    { entity: 'refund', id: 'rfnd_VALID12345', payment_id: 'pay_OTHER', amount: 10000, status: 'pending' },
    { entity: 'refund', id: 'rfnd_VALID12345', payment_id: 'pay_TEST123', amount: 9999, status: 'pending' },
    { entity: 'refund', id: 'rfnd_VALID12345', payment_id: 'pay_TEST123', amount: 10000, status: 'unknown_status' },
  ]) {
    const client = createRazorpayClient({
      env: { RAZORPAY_KEY_ID: 'test_key', RAZORPAY_KEY_SECRET: 'test_secret' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(badResp),
      }),
    });
    const { db } = setupHarness();
    const customManager = createNoDriverRefundManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => 1_000_000,
      razorpayClient: client,
    });
    const res = await customManager.processRefundIntent('job_1');
    assert.equal(res.errorCode, 'PROVIDER_RESPONSE_INVALID');
  }
});

test('38-41 currency handling & valid rfnd identifier', async () => {
  // Empty currency allowed, INR allowed, absent currency allowed, non-string rejected
  const errEmpty = classifyProviderError(new ProviderResponseError('Invalid shape'));
  assert.equal(errEmpty.code, 'PROVIDER_RESPONSE_INVALID');

  // Provider response with absent currency succeeds
  const hAbsent = setupHarness({
    provider: {
      createRefund: async args => ({
        id: 'rfnd_ABSENT', entity: 'refund', amount: args.amount,
        payment_id: args.paymentId, status: 'pending',
      }),
    },
  });
  const resAbsent = await hAbsent.manager.processRefundIntent('job_1');
  assert.equal(resAbsent.status, 'submitted');
  assert.equal(hAbsent.db.read('refund_requests', 'job_1').razorpayRefundId, 'rfnd_ABSENT');

  // Provider response with empty string currency succeeds
  const hEmpty = setupHarness({
    provider: {
      createRefund: async args => ({
        id: 'rfnd_EMPTY', entity: 'refund', amount: args.amount,
        currency: '', payment_id: args.paymentId, status: 'pending',
      }),
    },
  });
  const resEmpty = await hEmpty.manager.processRefundIntent('job_1');
  assert.equal(resEmpty.status, 'submitted');

  // Provider response with INR currency succeeds
  const hINR = setupHarness({
    provider: {
      createRefund: async args => ({
        id: 'rfnd_INR12345', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      }),
    },
  });
  const resINR = await hINR.manager.processRefundIntent('job_1');
  assert.equal(resINR.status, 'submitted');
});

// ── 42-48. Submitted Status Reconciler ──────────────────────────────────────
test('42 submitted GET pending increments reconciliationAttempts and keeps submitted', async () => {
  const { manager, db, nowMs } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PENDING1', reconciliationAttempts: 0 },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PENDING1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_PENDING1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'pending',
      }),
    },
  });
  const res = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res.reconciled, true);
  assert.equal(res.pending, true);

  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.reconciliationAttempts, 1);
  assert.equal(refund.reconciliationNextAttemptAt.toMillis(), nowMs + 30000);
});

test('43 submitted GET processed converges to confirmed with source reconciliation', async () => {
  const { manager, db, nowMs } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
      }),
    },
  });
  const res = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res.reconciled, true);

  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'confirmed');
  assert.equal(refund.confirmationSource, 'reconciliation');
  assert.equal(refund.confirmedAt.toMillis(), nowMs);

  const job = db.read('jobs', 'job_1');
  assert.equal(job.refundState, 'confirmed');
  assert.equal(job.refundConfirmedAt.toMillis(), nowMs);
  assert.equal(job.refundedAmountPaise, 10000);

  const outbox = db.read('notification_outbox', 'refund_confirmed:job_1');
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'refund_confirmed:job_1');
  assert.equal(outbox.eventType, 'refund_confirmed');
  assert.equal(outbox.resourceType, 'refund_request');
  assert.equal(outbox.resourceId, 'job_1');
  assert.equal(outbox.channel, 'whatsapp');
  assert.equal(outbox.recipientKey, 'customer:job_1');
  assert.equal(outbox.payloadVersion, 1);
  assert.deepEqual(outbox.payload, {
    jobId: 'job_1',
    jobStatus: 'cancelled_system',
    refundAmountPaise: 10000,
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.ownerToken, null);
  assert.equal(outbox.leaseUntil, null);
  assert.equal(outbox.nextAttemptAt.toMillis(), nowMs);
  assert.equal(outbox.attemptCount, 0);
  assert.equal(outbox.providerMessageId, null);
  assert.equal(outbox.lastErrorCode, null);
  assert.equal(outbox.createdAt.toMillis(), nowMs);
  assert.equal(outbox.updatedAt.toMillis(), nowMs);
  assert.equal(outbox.sentAt, null);
});

test('44 submitted GET failed converges to failed_terminal', async () => {
  const { manager, db } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_FAIL1' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_FAIL1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_FAIL1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'failed',
      }),
    },
  });
  const res = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res.status, 'failed_terminal');

  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'failed_terminal');
  assert.equal(refund.lastErrorCode, 'PROVIDER_REFUND_FAILED');

  const job = db.read('jobs', 'job_1');
  assert.equal(job.refundState, 'failed_terminal');
  assert.equal(job.refundNextAttemptAt, null);
});

test('45-47 GET wrong refund ID / payment ID / amount fails closed', async () => {
  const { manager, db } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_EXACT' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_EXACT' },
    provider: {
      getRefund: async () => {
        throw new ProviderResponseError('Mismatch in GET');
      },
    },
  });
  const res = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res.reconciled, false);
  assert.equal(db.read('refund_requests', 'job_1').state, 'submitted'); // unchanged
});

test('48 confirmed is absorbing and never regresses', async () => {
  const { manager, calls } = setupHarness({
    refundPatch: { state: 'confirmed', confirmationSource: 'webhook', razorpayRefundId: 'rfnd_CONF12345' },
    jobPatch: { refundState: 'confirmed', razorpayRefundId: 'rfnd_CONF12345' },
  });
  const res = await manager.processRefundIntent('job_1');
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'confirmed');
  assert.equal(calls.create.length, 0);

  const res2 = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res2.claimed, false);
  assert.equal(calls.get.length, 0);
});

// ── 49-55. Webhook Interaction ─────────────────────────────────────────────
function refundPayload(overrides = {}) {
  return {
    event: 'refund.processed',
    payload: { refund: { entity: {
      id: 'rfnd_REFUND1', payment_id: 'pay_TEST123', status: 'processed',
      currency: 'INR', amount: 10000, ...overrides,
    } } },
  };
}

function req(body = refundPayload()) {
  return {
    method: 'POST', rawBody: Buffer.from(JSON.stringify(body)), body,
    headers: { 'x-razorpay-signature': 'valid' },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    sendStatus(c) { this.statusCode = c; return this; },
  };
}

test('49 webhook-first unbound returns 500 and deletes processed_requests claim', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { razorpayRefundId: null, state: 'in_progress' },
  });
  const res = mockRes();
  await webhook.handleRazorpayWebhook(req(), res);
  assert.equal(res.statusCode, 500);

  const refund = db.read('refund_requests', jobId);
  assert.equal(refund.razorpayRefundId, null);
  assert.equal(refund.state, 'in_progress');

  assert.equal(db.read('processed_requests', 'razorpay:refund.processed:rfnd_REFUND1'), undefined);
});

test('50 bound webhook exact confirms both job and refund', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { razorpayRefundId: 'rfnd_REFUND1', state: 'submitted' },
    jobPatch: { razorpayRefundId: 'rfnd_REFUND1', refundState: 'submitted' },
  });
  const res = mockRes();
  await webhook.handleRazorpayWebhook(req(), res);
  assert.equal(res.statusCode, 200);

  const refund = db.read('refund_requests', jobId);
  assert.equal(refund.state, 'confirmed');
  assert.equal(refund.confirmationSource, 'webhook');

  const job = db.read('jobs', jobId);
  assert.equal(job.refundState, 'confirmed');
  assert.equal(job.refundedAmountPaise, 10000);
});

test('51 bound webhook refund ID mismatch fails closed with 500', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { razorpayRefundId: 'rfnd_DIFFERENT', state: 'submitted' },
    jobPatch: { razorpayRefundId: 'rfnd_DIFFERENT', refundState: 'submitted' },
  });
  const res = mockRes();
  await webhook.handleRazorpayWebhook(req(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(db.read('refund_requests', jobId).state, 'submitted');
});

test('52 bound webhook amount mismatch fails closed', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { razorpayRefundId: 'rfnd_REFUND1', state: 'submitted' },
    jobPatch: { razorpayRefundId: 'rfnd_REFUND1', refundState: 'submitted' },
  });
  const res = mockRes();
  await webhook.handleRazorpayWebhook(req(refundPayload({ amount: 9999 })), res);
  assert.equal(res.statusCode, 500);
  assert.equal(db.read('refund_requests', jobId).state, 'submitted');
});

test('53 duplicate webhook delivery returns 200 cleanly without re-processing', async () => {
  const { webhook } = setupHarness({
    refundPatch: { razorpayRefundId: 'rfnd_REFUND1', state: 'submitted' },
    jobPatch: { razorpayRefundId: 'rfnd_REFUND1', refundState: 'submitted' },
  });
  const res1 = mockRes();
  await webhook.handleRazorpayWebhook(req(), res1);
  assert.equal(res1.statusCode, 200);

  const res2 = mockRes();
  await webhook.handleRazorpayWebhook(req(), res2);
  assert.equal(res2.statusCode, 200);
});

test('54 late exact webhook converges failed_terminal to confirmed', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { state: 'failed_terminal', razorpayRefundId: 'rfnd_REFUND1' },
    jobPatch: { refundState: 'failed_terminal', razorpayRefundId: 'rfnd_REFUND1' },
  });
  const res = mockRes();
  await webhook.handleRazorpayWebhook(req(), res);
  assert.equal(res.statusCode, 200);

  assert.equal(db.read('refund_requests', jobId).state, 'confirmed');
  assert.equal(db.read('jobs', jobId).refundState, 'confirmed');
});

test('55 refund.failed webhook ignored with 200 and zero state mutation', async () => {
  const { webhook, db, jobId } = setupHarness({
    refundPatch: { razorpayRefundId: 'rfnd_REFUND1', state: 'submitted' },
  });
  const failedBody = {
    event: 'refund.failed',
    payload: { refund: { entity: {
      id: 'rfnd_REFUND1', payment_id: 'pay_TEST123', status: 'failed',
      currency: 'INR', amount: 10000,
    } } },
  };
  const res = mockRes();
  await webhook.handleRazorpayWebhook({
    method: 'POST', rawBody: Buffer.from(JSON.stringify(failedBody)), body: failedBody,
    headers: { 'x-razorpay-signature': 'valid' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.read('refund_requests', jobId).state, 'submitted');
});

// ── 56-60. Provenance & Invariant Tests ────────────────────────────────────
test('56 zero writes on eligibility failure', async () => {
  const { manager, db, jobId } = setupHarness({ jobPatch: { bookingFeePaise: 0 } });
  await assert.rejects(manager.processRefundIntent(jobId));
  const refund = db.read('refund_requests', jobId);
  assert.equal(refund.attemptCount, 0);
  assert.equal(refund.state, 'pending');
});

test('57 Stage9 never touches drivers, wallet balances, or ledger entries', async () => {
  const { manager, db, jobId } = setupHarness();
  db.seed('drivers', 'driver_1', { walletBalance: 50000 });
  db.seed('wallet_entries', 'entry_1', { deltaPaise: 10000 });

  await manager.processRefundIntent(jobId);

  assert.equal(db.read('drivers', 'driver_1').walletBalance, 50000);
  assert.equal(db.read('wallet_entries', 'entry_1').deltaPaise, 10000);
});

test('58 same durable key and body reused after timeout', async () => {
  let firstCall, secondCall;
  const timeoutErr = new Error('timed out');
  timeoutErr.name = 'AbortError';

  const { manager, calls, db, jobId } = setupHarness({
    provider: {
      createRefund: async args => {
        if (calls.create.length === 1) throw timeoutErr;
        return {
          id: 'rfnd_RETRY_OK', entity: 'refund', amount: args.amount,
          currency: 'INR', payment_id: args.paymentId, status: 'pending',
        };
      },
    },
  });

  // Attempt 1 -> timeout
  await manager.processRefundIntent(jobId);
  assert.equal(calls.create.length, 1);
  firstCall = { ...calls.create[0] };

  // Set due for retry
  db.data.refund_requests[jobId].nextAttemptAt = FakeTimestamp.fromMillis(500000);
  db.data.jobs[jobId].refundNextAttemptAt = FakeTimestamp.fromMillis(500000);

  // Attempt 2 -> success
  await manager.processRefundIntent(jobId);
  assert.equal(calls.create.length, 2);
  secondCall = { ...calls.create[1] };

  assert.deepEqual(firstCall, secondCall);
  assert.equal(secondCall.idempotencyKey, 'refund_no_driver_found_job_1');
  assert.equal(secondCall.amount, 10000);
});

test('59 same durable key and body reused after 409 conflict', async () => {
  const conflictErr = new Error('in progress');
  conflictErr.status = 409;
  conflictErr.providerBody = { error: { description: 'in progress' } };

  const { manager, calls, db, jobId } = setupHarness({
    provider: {
      createRefund: async args => {
        if (calls.create.length === 1) throw conflictErr;
        return {
          id: 'rfnd_409_OK', entity: 'refund', amount: args.amount,
          currency: 'INR', payment_id: args.paymentId, status: 'pending',
        };
      },
    },
  });

  await manager.processRefundIntent(jobId);
  assert.equal(db.read('refund_requests', jobId).state, 'retry_wait');

  db.data.refund_requests[jobId].nextAttemptAt = FakeTimestamp.fromMillis(500000);
  db.data.jobs[jobId].refundNextAttemptAt = FakeTimestamp.fromMillis(500000);

  await manager.processRefundIntent(jobId);
  assert.equal(db.read('refund_requests', jobId).state, 'submitted');
  assert.equal(calls.create[0].idempotencyKey, calls.create[1].idempotencyKey);
});

test('60 no refund-list identity adoption: payment already refunded does not bind arbitrary ID', async () => {
  const err = new Error('already refunded');
  err.status = 400;
  err.providerBody = { error: { description: 'Payment has already been fully refunded' } };

  const { manager, db, jobId } = setupHarness({
    provider: { createRefund: async () => { throw err; } },
  });

  const res = await manager.processRefundIntent(jobId);
  assert.equal(res.errorCode, 'PROVIDER_ALREADY_REFUNDED_AMBIGUOUS');
  assert.equal(db.read('refund_requests', jobId).razorpayRefundId, null);
  assert.equal(db.read('refund_requests', jobId).state, 'retry_wait');
});

test('61 R1 root schema exactness: exact 21 fields accepted, extra currency rejected with 0 writes/calls, missing fields rejected', async () => {
  // Canonical 21-field intent succeeds
  const hCanonical = setupHarness();
  const resValid = await hCanonical.manager.processRefundIntent('job_1');
  assert.equal(resValid.status, 'submitted');
  assert.equal(hCanonical.calls.create.length, 1);

  // Extra currency field on refund_requests rejected with zero writes and zero provider calls
  const hExtra = setupHarness({
    refundPatch: { currency: 'INR' },
  });
  const initialJob = { ...hExtra.db.read('jobs', 'job_1') };
  const initialRefund = { ...hExtra.db.read('refund_requests', 'job_1') };

  await assert.rejects(
    hExtra.manager.processRefundIntent('job_1'),
    err => err.code === 'REFUND_SCHEMA_INVALID'
  );
  assert.equal(hExtra.calls.create.length, 0);
  assert.deepEqual(hExtra.db.read('jobs', 'job_1'), initialJob);
  assert.deepEqual(hExtra.db.read('refund_requests', 'job_1'), initialRefund);

  // Missing fields rejected
  for (const missingField of ['providerIdempotencyKey', 'providerRequestHash', 'confirmationSource', 'lastErrorCode', 'reconciliationAttempts']) {
    const hMissing = setupHarness();
    delete hMissing.db.data.refund_requests['job_1'][missingField];
    await assert.rejects(
      hMissing.manager.processRefundIntent('job_1'),
      err => err.code === 'REFUND_SCHEMA_INVALID'
    );
    assert.equal(hMissing.calls.create.length, 0);
  }
});

test('62 R4 exact 60,000ms lease duration & boundary test', async () => {
  const claimClock = 1000000;
  let currentClock = claimClock;
  const h = setupHarness({ nowMs: currentClock });

  // Claim lease: sets leaseUntil = claimClock + 60,000ms
  const claimRes = await h.manager.processRefundIntent('job_1');
  assert.equal(claimRes.status, 'submitted');

  // Set to in_progress to test boundaries
  const leaseUntilMs = claimClock + 60000;
  h.db.data.refund_requests['job_1'].state = 'in_progress';
  h.db.data.refund_requests['job_1'].leaseUntil = FakeTimestamp.fromMillis(leaseUntilMs);
  h.db.data.refund_requests['job_1'].ownerToken = 'prior_token';
  h.db.data.refund_requests['job_1'].attemptCount = 1;
  h.db.data.refund_requests['job_1'].razorpayRefundId = null;
  h.db.data.refund_requests['job_1'].submittedAt = null;
  h.db.data.refund_requests['job_1'].reconciliationNextAttemptAt = null;
  h.db.data.refund_requests['job_1'].nextAttemptAt = FakeTimestamp.fromMillis(claimClock);
  h.db.data.jobs['job_1'].refundState = 'in_progress';
  h.db.data.jobs['job_1'].razorpayRefundId = null;
  h.db.data.jobs['job_1'].refundNextAttemptAt = FakeTimestamp.fromMillis(claimClock);

  // 1. now < leaseUntil (now = leaseUntil - 1ms) -> active, cannot reclaim
  h.manager = createNoDriverRefundManager({
    db: h.db,
    TimestampClass: FakeTimestamp,
    now: () => leaseUntilMs - 1,
    razorpayClient: h.fakeClient,
  });
  const resActive = await h.manager.processRefundIntent('job_1');
  assert.equal(resActive.claimed, false);
  assert.equal(resActive.reason, 'active_lease');

  // 2. now == leaseUntil -> expired, reclaimable
  h.manager = createNoDriverRefundManager({
    db: h.db,
    TimestampClass: FakeTimestamp,
    now: () => leaseUntilMs,
    razorpayClient: h.fakeClient,
  });
  const resExact = await h.manager.processRefundIntent('job_1');
  assert.equal(resExact.status, 'submitted');

  // 3. now > leaseUntil -> expired, reclaimable
  h.db.data.refund_requests['job_1'].state = 'in_progress';
  h.db.data.refund_requests['job_1'].leaseUntil = FakeTimestamp.fromMillis(leaseUntilMs);
  h.db.data.refund_requests['job_1'].ownerToken = 'prior_token';
  h.db.data.refund_requests['job_1'].attemptCount = 1;
  h.db.data.refund_requests['job_1'].razorpayRefundId = null;
  h.db.data.refund_requests['job_1'].submittedAt = null;
  h.db.data.refund_requests['job_1'].reconciliationNextAttemptAt = null;
  h.db.data.refund_requests['job_1'].nextAttemptAt = FakeTimestamp.fromMillis(claimClock);
  h.db.data.jobs['job_1'].refundState = 'in_progress';
  h.db.data.jobs['job_1'].razorpayRefundId = null;
  h.db.data.jobs['job_1'].refundNextAttemptAt = FakeTimestamp.fromMillis(claimClock);
  h.manager = createNoDriverRefundManager({
    db: h.db,
    TimestampClass: FakeTimestamp,
    now: () => leaseUntilMs + 1000,
    razorpayClient: h.fakeClient,
  });
  const resAfter = await h.manager.processRefundIntent('job_1');
  assert.equal(resAfter.status, 'submitted');
});

test('63 R8 attemptCount increments ONLY in Tx1, never in Tx2 or errors, never exceeds 5', async () => {
  // Tx2 error (timeout): attemptCount incremented in Tx1 (0 -> 1), stays 1 in Tx2B
  const hTimeout = setupHarness({
    provider: { createRefund: async () => { throw new Error('timed out'); } },
  });
  await hTimeout.manager.processRefundIntent('job_1');
  const refTimeout = hTimeout.db.read('refund_requests', 'job_1');
  assert.equal(refTimeout.state, 'retry_wait');
  assert.equal(refTimeout.attemptCount, 1);

  // Tx2 error (409): attemptCount incremented in Tx1 (0 -> 1), stays 1 in Tx2B
  const err409 = new Error('conflict');
  err409.status = 409;
  const h409 = setupHarness({
    provider: { createRefund: async () => { throw err409; } },
  });
  await h409.manager.processRefundIntent('job_1');
  const ref409 = h409.db.read('refund_requests', 'job_1');
  assert.equal(ref409.state, 'retry_wait');
  assert.equal(ref409.attemptCount, 1);

  // Permanent 4xx: attemptCount incremented in Tx1 (0 -> 1), stays 1 in Tx2C
  const err401 = new Error('unauthorized');
  err401.status = 401;
  const h401 = setupHarness({
    provider: { createRefund: async () => { throw err401; } },
  });
  await h401.manager.processRefundIntent('job_1');
  const ref401 = h401.db.read('refund_requests', 'job_1');
  assert.equal(ref401.state, 'failed_terminal');
  assert.equal(ref401.attemptCount, 1);

  // When attemptCount is already 5, processRefundIntent transitions to failed_terminal with ZERO createRefund calls
  let createCalls = 0;
  const hMax = setupHarness({
    refundPatch: { attemptCount: 5, state: 'retry_wait' },
    provider: { createRefund: async () => { createCalls++; } },
  });
  const resMax = await hMax.manager.processRefundIntent('job_1');
  assert.equal(resMax.claimed, false);
  assert.equal(resMax.status, 'failed_terminal');
  assert.equal(createCalls, 0);
  assert.equal(hMax.db.read('refund_requests', 'job_1').attemptCount, 5);
});

test('64 reconciler preserves progressed notification_outbox on duplicate reconciliation', async () => {
  const { manager, db, nowMs } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
      }),
    },
  });

  // Pre-seed an outbox record progressed to 'sent'
  db.seed('notification_outbox', 'refund_confirmed:job_1', {
    eventId: 'refund_confirmed:job_1',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_1',
    channel: 'whatsapp',
    recipientKey: 'customer:job_1',
    payloadVersion: 1,
    payload: {
      jobId: 'job_1',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 10000,
    },
    state: 'sent',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    attemptCount: 1,
    providerMessageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
    lastErrorCode: null,
    createdAt: FakeTimestamp.fromMillis(nowMs - 10000),
    updatedAt: FakeTimestamp.fromMillis(nowMs - 5000),
    sentAt: FakeTimestamp.fromMillis(nowMs - 5000),
  });

  const res = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(res.reconciled, true);
  assert.equal(res.status, 'confirmed');

  const outbox = db.read('notification_outbox', 'refund_confirmed:job_1');
  assert.equal(outbox.state, 'sent');
  assert.equal(outbox.providerMessageId, 'wamid.HBgLMTIzNDU2Nzg5MA==');
  assert.equal(outbox.attemptCount, 1);
  assert.equal(outbox.sentAt.toMillis(), nowMs - 5000);
});

test('65 reconciler with contradictory notification_outbox payload fails closed with OUTBOX_COLLISION_INVALID', async () => {
  const { manager, db } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
      }),
    },
  });

  db.seed('notification_outbox', 'refund_confirmed:job_1', {
    eventId: 'refund_confirmed:job_1',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_1',
    channel: 'whatsapp',
    recipientKey: 'customer:job_1',
    payloadVersion: 1,
    payload: {
      jobId: 'job_1',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 99999, // Contradictory amount!
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: FakeTimestamp.fromMillis(1000000),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: FakeTimestamp.fromMillis(1000000),
    updatedAt: FakeTimestamp.fromMillis(1000000),
    sentAt: null,
  });

  await assert.rejects(
    async () => manager.reconcileSubmittedRefund('job_1'),
    err => err.code === 'OUTBOX_COLLISION_INVALID'
  );

  // Assert refund request and job remain in submitted state with zero changes
  const refund = db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.confirmedAt, null);

  const job = db.read('jobs', 'job_1');
  assert.equal(job.refundState, 'submitted');
  assert.equal(job.refundConfirmedAt, null);
});

test('66 webhook confirms first and creates outbox; subsequent reconciler absorbs confirmed and preserves outbox', async () => {
  const { manager, db, webhook, nowMs } = setupHarness({
    refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_RACE1' },
    jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_RACE1' },
    provider: {
      getRefund: async () => ({
        id: 'rfnd_RACE1', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
      }),
    },
  });

  // 1. Webhook arrives first
  const webhookRes = mockRes();
  await webhook.handleRazorpayWebhook(req(refundPayload({ id: 'rfnd_RACE1', amount: 10000 })), webhookRes);
  assert.equal(webhookRes.statusCode, 200);

  const outboxAfterWebhook = db.read('notification_outbox', 'refund_confirmed:job_1');
  assert.ok(outboxAfterWebhook);
  assert.equal(outboxAfterWebhook.state, 'pending');

  // Progress outbox to in_progress to prove reconciler does not touch it
  db.data.notification_outbox['refund_confirmed:job_1'].state = 'in_progress';
  db.data.notification_outbox['refund_confirmed:job_1'].ownerToken = 'token_worker';
  db.data.notification_outbox['refund_confirmed:job_1'].attemptCount = 1;
  db.data.notification_outbox['refund_confirmed:job_1'].leaseUntil = FakeTimestamp.fromMillis(nowMs + 60000);

  // 2. Reconciler runs after webhook
  const reconcilerRes = await manager.reconcileSubmittedRefund('job_1');
  assert.equal(reconcilerRes.status, 'confirmed');

  const outboxAfterReconciler = db.read('notification_outbox', 'refund_confirmed:job_1');
  assert.equal(outboxAfterReconciler.state, 'in_progress');
  assert.equal(outboxAfterReconciler.ownerToken, 'token_worker');
});

test('67 attempt-5 boundary check: starting at attemptCount: 4, failure transitions to failed_terminal with attemptCount: 5 and zero attempt #6', async () => {
  let createCalls = 0;
  const err503 = new Error('Service Unavailable');
  err503.status = 503;

  const h = setupHarness({
    refundPatch: {
      attemptCount: 4,
      state: 'retry_wait',
      nextAttemptAt: FakeTimestamp.fromMillis(1_000_000),
    },
    provider: {
      createRefund: async () => {
        createCalls++;
        throw err503;
      },
    },
  });

  // 1. Execute attempt #5
  const res = await h.manager.processRefundIntent('job_1');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.finalized, true);
  assert.equal(res.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(createCalls, 1); // Exact 1 provider call made (#5)

  const refund = h.db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'failed_terminal');
  assert.equal(refund.attemptCount, 5); // Exactly 5, never incremented beyond 5
  assert.equal(refund.lastErrorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(refund.ownerToken, null);
  assert.equal(refund.leaseUntil, null);
  assert.equal(refund.nextAttemptAt, null);

  const job = h.db.read('jobs', 'job_1');
  assert.equal(job.refundState, 'failed_terminal');
  assert.equal(job.refundNextAttemptAt, null);

  // 2. Subsequent execution must NOT execute provider call #6
  const resSubsequent = await h.manager.processRefundIntent('job_1');
  assert.equal(resSubsequent.claimed, false);
  assert.equal(resSubsequent.status, 'failed_terminal');
  assert.equal(createCalls, 1); // Zero attempt #6 issued!
  assert.equal(h.db.read('refund_requests', 'job_1').attemptCount, 5);
});

test('68 attempt-5 boundary check: starting at attemptCount: 4, success moves to submitted with attemptCount: 5', async () => {
  let createCalls = 0;
  const h = setupHarness({
    refundPatch: {
      attemptCount: 4,
      state: 'retry_wait',
      nextAttemptAt: FakeTimestamp.fromMillis(1_000_000),
    },
    provider: {
      createRefund: async args => {
        createCalls++;
        return {
          id: 'rfnd_ATTEMPT5',
          entity: 'refund',
          amount: args.amount,
          currency: 'INR',
          payment_id: args.paymentId,
          status: 'pending',
        };
      },
    },
  });

  const res = await h.manager.processRefundIntent('job_1');
  assert.equal(res.status, 'submitted');
  assert.equal(res.finalized, true);
  assert.equal(res.refundId, 'rfnd_ATTEMPT5');
  assert.equal(createCalls, 1);

  const refund = h.db.read('refund_requests', 'job_1');
  assert.equal(refund.state, 'submitted');
  assert.equal(refund.attemptCount, 5);
  assert.equal(refund.razorpayRefundId, 'rfnd_ATTEMPT5');

  const job = h.db.read('jobs', 'job_1');
  assert.equal(job.refundState, 'submitted');
  assert.equal(job.razorpayRefundId, 'rfnd_ATTEMPT5');
});

function makeValidOutbox(nowMs, state = 'pending', overrides = {}) {
  const base = {
    eventId: 'refund_confirmed:job_1',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_1',
    channel: 'whatsapp',
    recipientKey: 'customer:job_1',
    payloadVersion: 1,
    payload: {
      jobId: 'job_1',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 10000,
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: FakeTimestamp.fromMillis(nowMs),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: FakeTimestamp.fromMillis(nowMs - 10000),
    updatedAt: FakeTimestamp.fromMillis(nowMs - 10000),
    sentAt: null,
  };
  if (state === 'in_progress') {
    return {
      ...base,
      state: 'in_progress',
      ownerToken: 'worker_token_1',
      leaseUntil: FakeTimestamp.fromMillis(nowMs + 60000),
      attemptCount: 1,
      ...overrides,
    };
  }
  if (state === 'retry_wait') {
    return {
      ...base,
      state: 'retry_wait',
      attemptCount: 1,
      nextAttemptAt: FakeTimestamp.fromMillis(nowMs + 30000),
      lastErrorCode: 'provider_unavailable',
      ...overrides,
    };
  }
  if (state === 'sent') {
    return {
      ...base,
      state: 'sent',
      attemptCount: 1,
      sentAt: FakeTimestamp.fromMillis(nowMs - 5000),
      updatedAt: FakeTimestamp.fromMillis(nowMs - 5000),
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
      updatedAt: FakeTimestamp.fromMillis(nowMs - 5000),
      ...overrides,
    };
  }
  return { ...base, ...overrides };
}

for (const state of ['pending', 'in_progress', 'retry_wait', 'sent', 'failed_terminal']) {
  test(`69 reconciler preserves existing ${state} notification_outbox without resetting delivery fields`, async () => {
    const { manager, db, nowMs } = setupHarness({
      refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
      jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
      provider: {
        getRefund: async () => ({
          id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
          currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
        }),
      },
    });

    const seededOutbox = makeValidOutbox(nowMs, state);
    db.seed('notification_outbox', 'refund_confirmed:job_1', seededOutbox);

    const res = await manager.reconcileSubmittedRefund('job_1');
    assert.equal(res.reconciled, true);
    assert.equal(res.status, 'confirmed');

    const outboxAfter = db.read('notification_outbox', 'refund_confirmed:job_1');
    assert.deepEqual(outboxAfter, seededOutbox);
  });
}

const reconcilerCorruptMutations = [
  { name: 'extra root key', mutate: o => { o.extraField = 'bad'; } },
  { name: 'missing root key (sentAt)', mutate: o => { delete o.sentAt; } },
  { name: 'missing root key (attemptCount)', mutate: o => { delete o.attemptCount; } },
  { name: 'wrong eventId', mutate: o => { o.eventId = 'refund_confirmed:other_job'; } },
  { name: 'wrong eventType', mutate: o => { o.eventType = 'job_confirmed'; } },
  { name: 'wrong resourceType', mutate: o => { o.resourceType = 'job'; } },
  { name: 'wrong resourceId', mutate: o => { o.resourceId = 'other_job'; } },
  { name: 'wrong channel', mutate: o => { o.channel = 'sms'; } },
  { name: 'wrong recipientKey', mutate: o => { o.recipientKey = 'customer:other_job'; } },
  { name: 'raw phone in recipientKey', mutate: o => { o.recipientKey = '+919876543210'; } },
  { name: 'wrong payloadVersion', mutate: o => { o.payloadVersion = 2; } },
  { name: 'missing payload key (refundAmountPaise)', mutate: o => { delete o.payload.refundAmountPaise; } },
  { name: 'extra payload key (customerPhone)', mutate: o => { o.payload.customerPhone = '+919876543210'; } },
  { name: 'wrong payload jobId', mutate: o => { o.payload.jobId = 'other_job'; } },
  { name: 'wrong payload jobStatus', mutate: o => { o.payload.jobStatus = 'accepted'; } },
  { name: 'wrong payload refundAmountPaise', mutate: o => { o.payload.refundAmountPaise = 100; } },
  { name: 'null payload refundAmountPaise', mutate: o => { o.payload.refundAmountPaise = null; } },
  { name: 'unknown state enum', mutate: o => { o.state = 'completed'; } },
  { name: 'pending with non-zero attemptCount', mutate: o => { o.attemptCount = 1; } },
  { name: 'pending with non-null ownerToken', mutate: o => { o.ownerToken = 'tok'; } },
  { name: 'pending with non-null leaseUntil', mutate: (o, nowMs) => { o.leaseUntil = FakeTimestamp.fromMillis(nowMs); } },
  { name: 'pending with non-null providerMessageId', mutate: o => { o.providerMessageId = 'wamid.123'; } },
  { name: 'pending with non-null sentAt', mutate: (o, nowMs) => { o.sentAt = FakeTimestamp.fromMillis(nowMs); } },
  { name: 'pending with non-null lastErrorCode', mutate: o => { o.lastErrorCode = 'internal_error'; } },
  { name: 'in_progress with zero attemptCount', state: 'in_progress', mutate: o => { o.attemptCount = 0; } },
  { name: 'in_progress with null ownerToken', state: 'in_progress', mutate: o => { o.ownerToken = null; } },
  { name: 'in_progress with null leaseUntil', state: 'in_progress', mutate: o => { o.leaseUntil = null; } },
  { name: 'in_progress with non-null sentAt', state: 'in_progress', mutate: (o, nowMs) => { o.sentAt = FakeTimestamp.fromMillis(nowMs); } },
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
  { name: 'invalid createdAt/updatedAt ordering', mutate: (o, nowMs) => { o.createdAt = FakeTimestamp.fromMillis(nowMs + 10000); o.updatedAt = FakeTimestamp.fromMillis(nowMs); } },
];

for (const m of reconcilerCorruptMutations) {
  test(`70 reconciler rejects corrupt notification_outbox (${m.name}) with OUTBOX_COLLISION_INVALID and zero writes`, async () => {
    const { manager, db, nowMs } = setupHarness({
      refundPatch: { state: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
      jobPatch: { refundState: 'submitted', razorpayRefundId: 'rfnd_PROC1' },
      provider: {
        getRefund: async () => ({
          id: 'rfnd_PROC1', entity: 'refund', amount: 10000,
          currency: 'INR', payment_id: 'pay_TEST123', status: 'processed',
        }),
      },
    });

    const outbox = makeValidOutbox(nowMs, m.state || 'pending');
    m.mutate(outbox, nowMs);
    db.seed('notification_outbox', 'refund_confirmed:job_1', outbox);

    await assert.rejects(
      async () => manager.reconcileSubmittedRefund('job_1'),
      err => err.code === 'OUTBOX_COLLISION_INVALID'
    );

    const job = db.read('jobs', 'job_1');
    assert.equal(job.refundState, 'submitted');
    assert.equal(job.razorpayRefundId, 'rfnd_PROC1');
    assert.equal(job.refundConfirmedAt, null);

    const refund = db.read('refund_requests', 'job_1');
    assert.equal(refund.state, 'submitted');
    assert.equal(refund.confirmedAt, null);

    const outboxAfter = db.read('notification_outbox', 'refund_confirmed:job_1');
    assert.deepEqual(outboxAfter, outbox);
  });
}
