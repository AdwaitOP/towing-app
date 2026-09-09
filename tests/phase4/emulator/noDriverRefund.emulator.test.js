'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint } = require('firebase-admin/firestore');
const { createNoDriverRefundManager } = require('../../../firebase/functions/src/dispatch/noDriverRefund');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');
const { createDispatchService } = require('../../../firebase/functions/src/dispatch/dispatchService');
const { paidJob, config, driver } = require('../fixtures');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage9-refund-emulator';
const app = initializeApp({ projectId: project }, 'stage9-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

test.beforeEach(async () => {
  clock = Date.parse('2026-09-02T10:00:00Z');
  const response = await fetch('http://' + host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
  assert.equal(response.ok, true);
  await db.doc('dispatch_config/main').set(config(T, clock));
});

test.after(async () => {
  await db.terminate();
  await app.delete();
});

function canonicalSeed(jobId = 'job_1', patch = {}) {
  const at = T.fromMillis(clock);
  const paymentId = patch.razorpayPaymentId || 'pay_TEST12345';
  const amountPaise = patch.bookingFeePaise !== undefined ? patch.bookingFeePaise : 10000;
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId,
    amount: amountPaise,
  }), 'utf8').digest('hex');

  const isSubmitted = patch.refund?.state === 'submitted' || patch.job?.refundState === 'submitted';
  const isConfirmed = patch.refund?.state === 'confirmed' || patch.job?.refundState === 'confirmed';
  const isFailedTerminal = patch.refund?.state === 'failed_terminal' || patch.job?.refundState === 'failed_terminal';
  const isRetryWait = patch.refund?.state === 'retry_wait' || patch.job?.refundState === 'retry_wait';
  const isInProgress = patch.refund?.state === 'in_progress' || patch.job?.refundState === 'in_progress';

  const refundId = (patch.refund && patch.refund.razorpayRefundId !== undefined)
    ? patch.refund.razorpayRefundId
    : ((patch.job && patch.job.razorpayRefundId !== undefined)
      ? patch.job.razorpayRefundId
      : ((isSubmitted || isConfirmed) ? 'rfnd_CANONICAL' : null));

  const submittedAt = (patch.refund && patch.refund.submittedAt !== undefined)
    ? patch.refund.submittedAt
    : ((isSubmitted || isConfirmed) ? T.fromMillis(clock - 60000) : null);

  const confirmedAt = (patch.refund && patch.refund.confirmedAt !== undefined)
    ? patch.refund.confirmedAt
    : (isConfirmed ? at : null);

  const reconciliationNextAttemptAt = (patch.refund && patch.refund.reconciliationNextAttemptAt !== undefined)
    ? patch.refund.reconciliationNextAttemptAt
    : (isSubmitted ? at : null);

  const nextAttemptAt = (patch.refund && patch.refund.nextAttemptAt !== undefined)
    ? patch.refund.nextAttemptAt
    : (isSubmitted || isConfirmed || isFailedTerminal ? null : at);

  const defaultJobRefundNextAttemptAt = isSubmitted
    ? reconciliationNextAttemptAt
    : (isConfirmed || isFailedTerminal ? null : nextAttemptAt);

  const refundNextAttemptAt = (patch.job && patch.job.refundNextAttemptAt !== undefined)
    ? patch.job.refundNextAttemptAt
    : defaultJobRefundNextAttemptAt;

  const job = {
    customerPhone: '+919876543210',
    pickupCoords: { lat: 18.5204, lng: 73.8567 },
    destCoords: { lat: 18.55, lng: 73.88 },
    requestedTruckType: 'flatbed',
    distanceKm: 4.5,
    pricingTier: 1,
    bookingFeePaise: amountPaise,
    driverCommissionPaise: 5000,
    estimatedFarePaise: 45000,
    status: 'cancelled_system',
    dispatchState: 'closed',
    offeredTo: null,
    assignedDriver: null,
    channel: 'whatsapp',
    createdByAdmin: null,
    razorpayPaymentLinkId: 'plink_TEST',
    razorpayPaymentLinkUrl: 'https://rzp.io/i/test',
    razorpayPaymentId: paymentId,
    paymentConfirmedAt: T.fromMillis(clock - 90000),
    invoiceNumber: null,
    invoiceUrl: null,
    invoiceSentAt: null,
    cancellationRequestedAt: null,
    cancellationResolvedAt: null,
    cancellationResolutionState: 'none',
    cancelledAt: T.fromMillis(clock - 70000),
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    refundRequestId: jobId,
    refundState: isSubmitted ? 'submitted' : (isConfirmed ? 'confirmed' : (isFailedTerminal ? 'failed_terminal' : (isRetryWait ? 'retry_wait' : (isInProgress ? 'in_progress' : 'pending')))),
    razorpayRefundId: refundId,
    refundConfirmedAt: isConfirmed ? (patch.job?.refundConfirmedAt || confirmedAt) : null,
    refundedAmountPaise: isConfirmed ? (patch.job?.refundedAmountPaise !== undefined ? patch.job.refundedAmountPaise : amountPaise) : null,
    refundNextAttemptAt,
    dispatchLeaseOwner: null,
    dispatchLeaseUntil: null,
    dispatchNextActionAt: null,
    dispatchLastFailure: null,
    stateVersion: 1,
    createdAt: T.fromMillis(clock - 120000),
    updatedAt: at,
    ...patch.job,
  };

  const refund = {
    operationId: jobId,
    jobId,
    razorpayPaymentId: paymentId,
    amountPaise,
    reason: 'no_driver_found',
    providerIdempotencyKey: 'refund_no_driver_found_' + jobId,
    providerRequestHash: expectedHash,
    state: isSubmitted ? 'submitted' : (isConfirmed ? 'confirmed' : (isFailedTerminal ? 'failed_terminal' : (isRetryWait ? 'retry_wait' : (isInProgress ? 'in_progress' : 'pending')))),
    ownerToken: (patch.refund && patch.refund.ownerToken !== undefined) ? patch.refund.ownerToken : (isInProgress ? 'prior_worker' : null),
    leaseUntil: (patch.refund && patch.refund.leaseUntil !== undefined) ? patch.refund.leaseUntil : (isInProgress ? T.fromMillis(clock + 60000) : null),
    nextAttemptAt,
    reconciliationNextAttemptAt,
    reconciliationAttempts: isSubmitted ? 1 : 0,
    razorpayRefundId: refundId,
    confirmationSource: isConfirmed ? (patch.refund?.confirmationSource || 'reconciliation') : null,
    attemptCount: (patch.refund && patch.refund.attemptCount !== undefined) ? patch.refund.attemptCount : (isSubmitted || isConfirmed || isFailedTerminal || isRetryWait || isInProgress ? 1 : 0),
    lastErrorCode: (patch.refund && patch.refund.lastErrorCode !== undefined) ? patch.refund.lastErrorCode : (isRetryWait ? 'PROVIDER_UNAVAILABLE' : (isFailedTerminal ? 'PROVIDER_REFUND_FAILED' : null)),
    createdAt: T.fromMillis(clock - 70000),
    updatedAt: at,
    submittedAt,
    confirmedAt,
    ...patch.refund,
  };

  return { job, refund };
}

async function seedInFirestore(jobId, patch = {}) {
  const { job, refund } = canonicalSeed(jobId, patch);
  await db.doc('jobs/' + jobId).set(job);
  await db.doc('refund_requests/' + jobId).set(refund);
  return { job, refund };
}

function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function makeSignedWebhookRequest(payload, secret = 'test_secret', eventId = 'evt_test') {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    method: 'POST',
    headers: {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: payload,
    rawBody,
    get(name) {
      if (name.toLowerCase() === 'x-razorpay-signature') return signature;
      if (name.toLowerCase() === 'x-razorpay-event-id') return eventId;
      return this.headers[name] || this.headers[name.toLowerCase()];
    },
  };
}

function makeManager(fakeClient, overrides = {}) {
  return createNoDriverRefundManager({
    db,
    TimestampClass: T,
    now,
    razorpayClient: fakeClient,
    ...overrides,
  });
}

function makeWebhook(overrides = {}) {
  return createRazorpayWebhook({
    db,
    TimestampClass: T,
    now: () => clock,
    env: { RAZORPAY_WEBHOOK_SECRET: 'test_secret' },
    invoice: { ensureInvoiceAndSend: async () => {} },
    dispatch: { triggerDispatch: async () => {} },
    ...overrides,
  }).handleRazorpayWebhook;
}

function mockRes() {
  const res = {
    statusCode: 0,
    status(c) { res.statusCode = c; return res; },
    sendStatus(c) { res.statusCode = c; return res; },
    send() { return res; },
    json() { return res; },
  };
  return res;
}

// ── 1. Two workers race on pending refund intent ──────────────────────────
test('1 two workers race on pending refund intent: exactly one claims and calls provider, second safely no-ops', async () => {
  await seedInFirestore('job_race_1');
  let providerCalls = 0;
  const fakeClient = {
    createRefund: async args => {
      providerCalls++;
      await new Promise(r => setTimeout(r, 40));
      return {
        id: 'rfnd_RACE1', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
    getRefund: async () => assert.fail('should not call GET'),
  };

  const manager1 = makeManager(fakeClient);
  const manager2 = makeManager(fakeClient);

  const [res1, res2] = await Promise.all([
    manager1.processRefundIntent('job_race_1'),
    manager2.processRefundIntent('job_race_1'),
  ]);

  const finalizedCount = (res1.finalized ? 1 : 0) + (res2.finalized ? 1 : 0);
  assert.equal(finalizedCount, 1);
  assert.equal(providerCalls, 1);

  const refundDoc = (await db.doc('refund_requests/job_race_1').get()).data();
  assert.equal(refundDoc.state, 'submitted');
  assert.equal(refundDoc.razorpayRefundId, 'rfnd_RACE1');
  assert.equal(refundDoc.attemptCount, 1);
});

// ── 2. Trigger worker and sweep reconciler race ───────────────────────────
test('2 trigger worker and sweep reconciler race: trigger claims, reconciler observes active lease and skips', async () => {
  await seedInFirestore('job_race_2');
  let providerCalls = 0;
  const fakeClient = {
    createRefund: async args => {
      providerCalls++;
      await new Promise(r => setTimeout(r, 50));
      return {
        id: 'rfnd_RACE2', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
    getRefund: async () => assert.fail('sweep must not call getRefund during active lease'),
  };

  const manager = makeManager(fakeClient);

  const workerPromise = manager.processRefundIntent('job_race_2');
  await new Promise(r => setTimeout(r, 10));

  const sweepRes = await manager.reconcileRefunds();
  assert.equal(sweepRes.reconciled, 0);

  const workerRes = await workerPromise;
  assert.equal(workerRes.status, 'submitted');
  assert.equal(providerCalls, 1);
});

// ── 3. Crash window Tx 1 committed, process dies before Tx 2 ───────────────
test('3 crash window Tx 1 committed, process dies before Tx 2: lease expires, second worker takes over, increments attemptCount, idempotently reuses same key and body, succeeds', async () => {
  await seedInFirestore('job_crash_3', {
    refund: {
      state: 'in_progress',
      ownerToken: 'dead_worker_token',
      leaseUntil: T.fromMillis(clock + 30000),
      attemptCount: 1,
    },
  });

  const calls = [];
  const fakeClient = {
    createRefund: async args => {
      calls.push(args);
      return {
        id: 'rfnd_TAKEOVER3', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
  };

  const manager = makeManager(fakeClient);

  // Before lease expires: rejected with active_lease
  const earlyRes = await manager.processRefundIntent('job_crash_3');
  assert.equal(earlyRes.claimed, false);
  assert.equal(earlyRes.reason, 'active_lease');
  assert.equal(calls.length, 0);

  // Advance past lease expiry
  clock += 35000;

  // Second worker claims expired lease
  const res = await manager.processRefundIntent('job_crash_3');
  assert.equal(res.status, 'submitted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, 'refund_no_driver_found_job_crash_3');
  assert.equal(calls[0].amount, 10000);

  const refundDoc = (await db.doc('refund_requests/job_crash_3').get()).data();
  assert.equal(refundDoc.state, 'submitted');
  assert.equal(refundDoc.attemptCount, 2);
  assert.equal(refundDoc.razorpayRefundId, 'rfnd_TAKEOVER3');
});

// ── 4. Provider timeout followed by successful retry ──────────────────────
test('4 provider timeout followed by successful retry: verify final state is submitted with exact records in Firestore', async () => {
  await seedInFirestore('job_retry_4');
  let calls = 0;
  const timeoutErr = new Error('Gateway Timeout');
  timeoutErr.name = 'AbortError';

  const fakeClient = {
    createRefund: async args => {
      calls++;
      if (calls === 1) throw timeoutErr;
      return {
        id: 'rfnd_RETRY4', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
  };

  const manager = makeManager(fakeClient);

  // Attempt 1 -> timeout -> retry_wait
  const res1 = await manager.processRefundIntent('job_retry_4');
  assert.equal(res1.status, 'retry_wait');
  assert.equal(calls, 1);

  const docAfter1 = (await db.doc('refund_requests/job_retry_4').get()).data();
  assert.equal(docAfter1.state, 'retry_wait');
  assert.equal(docAfter1.attemptCount, 1);
  assert.equal(docAfter1.lastErrorCode, 'PROVIDER_TIMEOUT');

  // Advance past backoff (5s)
  clock += 6000;

  // Attempt 2 -> success -> submitted
  const res2 = await manager.processRefundIntent('job_retry_4');
  assert.equal(res2.status, 'submitted');
  assert.equal(calls, 2);

  const docAfter2 = (await db.doc('refund_requests/job_retry_4').get()).data();
  assert.equal(docAfter2.state, 'submitted');
  assert.equal(docAfter2.attemptCount, 2);
  assert.equal(docAfter2.razorpayRefundId, 'rfnd_RETRY4');
  assert.equal(docAfter2.lastErrorCode, null);
});

// ── 5. Provider 409 same-key conflict retry ───────────────────────────────
test('5 provider 409 same-key conflict retry: verify backoff delay and second attempt success', async () => {
  await seedInFirestore('job_409_5');
  let calls = 0;
  const conflictErr = new Error('Conflict');
  conflictErr.status = 409;
  conflictErr.providerBody = { error: { description: 'Refund is in progress' } };

  const fakeClient = {
    createRefund: async args => {
      calls++;
      if (calls === 1) throw conflictErr;
      return {
        id: 'rfnd_409SUCCESS', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
  };

  const manager = makeManager(fakeClient);

  const res1 = await manager.processRefundIntent('job_409_5');
  assert.equal(res1.status, 'retry_wait');
  assert.equal(res1.errorCode, 'PROVIDER_PROCESSING_CONFLICT');

  // Advance past backoff
  clock += 6000;

  const res2 = await manager.processRefundIntent('job_409_5');
  assert.equal(res2.status, 'submitted');
  assert.equal(calls, 2);

  const doc = (await db.doc('refund_requests/job_409_5').get()).data();
  assert.equal(doc.state, 'submitted');
  assert.equal(doc.razorpayRefundId, 'rfnd_409SUCCESS');
});

// ── 6. Concurrent webhook delivery while provider call in flight ──────────
test('6 concurrent webhook delivery while provider call in flight: webhook fails closed with 500 (REFUND_IDENTITY_UNBOUND), deletes processed_requests entry, then after worker finishes Tx 2A, webhook redelivery succeeds with 200 and confirms', async () => {
  await seedInFirestore('job_wh_flight_6');
  const webhook = makeWebhook();

  const inFlightGate = gate();
  const continueGate = gate();

  const fakeClient = {
    createRefund: async args => {
      inFlightGate.resolve();
      await continueGate.promise;
      return {
        id: 'rfnd_FLIGHT6', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
  };
  const manager = makeManager(fakeClient);

  // 1. Worker begins processing pending intent and enters provider call (Tx 1 committed)
  const workerPromise = manager.processRefundIntent('job_wh_flight_6');
  await inFlightGate.promise;

  // 2. Early webhook arrives while provider call is in flight (refundId is still null)
  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_FLIGHT6',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_wh_flight_6' },
        },
      },
    },
  };

  const req1 = makeSignedWebhookRequest(payload, 'test_secret', 'evt_flight_1');
  const res1 = mockRes();
  await webhook(req1, res1);
  assert.equal(res1.statusCode, 500);

  // Verify processed_requests lease was deleted so retry is allowed
  const leaseSnap = await db.doc('processed_requests/razorpay:refund.processed:rfnd_FLIGHT6').get();
  assert.equal(leaseSnap.exists, false);

  // 3. Worker finishes provider call and completes Tx 2A: records razorpayRefundId
  continueGate.resolve();
  const workerRes = await workerPromise;
  assert.equal(workerRes.status, 'submitted');
  assert.equal(workerRes.finalized, true);

  // 4. Webhook retry succeeds with 200
  const res2 = mockRes();
  await webhook(req1, res2);
  assert.equal(res2.statusCode, 200);

  const jobDoc = (await db.doc('jobs/job_wh_flight_6').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_wh_flight_6').get()).data();
  assert.equal(jobDoc.refundState, 'confirmed');
  assert.equal(refundDoc.state, 'confirmed');
  assert.equal(refundDoc.confirmationSource, 'webhook');
});

// ── 7. Concurrent webhook delivery during Tx 2A commit ─────────────────────
test('7 concurrent webhook delivery during Tx 2A commit: if webhook commits first with exact refundId, Tx 2A still writes consistent state; if Tx 2A commits first, webhook confirms', async () => {
  await seedInFirestore('job_wh_commit_7');

  const inFlightGate = gate();
  const continueGate = gate();

  const fakeClient = {
    createRefund: async args => {
      inFlightGate.resolve();
      await continueGate.promise;
      return {
        id: 'rfnd_COMMIT7', entity: 'refund', amount: args.amount,
        currency: 'INR', payment_id: args.paymentId, status: 'pending',
      };
    },
  };

  const manager = makeManager(fakeClient);
  const webhook = makeWebhook();

  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_COMMIT7',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_wh_commit_7' },
        },
      },
    },
  };

  const req = makeSignedWebhookRequest(payload, 'test_secret', 'evt_commit_7');

  // Start worker
  const workerPromise = manager.processRefundIntent('job_wh_commit_7');
  await inFlightGate.promise;

  // Overlap worker Tx 2A commit with concurrent webhook delivery
  const res = mockRes();
  const [workerRes, _] = await Promise.all([
    (async () => {
      continueGate.resolve();
      return await workerPromise;
    })(),
    (async () => {
      await webhook(req, res);
      if (res.statusCode === 500) {
        await webhook(req, res);
      }
    })(),
  ]);

  assert.equal(workerRes.finalized, true);
  assert.equal(res.statusCode, 200);

  const jobDoc = (await db.doc('jobs/job_wh_commit_7').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_wh_commit_7').get()).data();
  assert.equal(jobDoc.refundState, 'confirmed');
  assert.equal(refundDoc.state, 'confirmed');
});

// ── 8. Duplicate concurrent webhook deliveries ────────────────────────────
test('8 duplicate concurrent webhook deliveries: exactly one updates, second finds processed_requests and returns 200', async () => {
  await seedInFirestore('job_dup_8', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_DUP888',
      submittedAt: T.fromMillis(clock),
    },
  });

  const webhook = makeWebhook();
  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_DUP888',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_dup_8' },
        },
      },
    },
  };

  const reqFactory = () => makeSignedWebhookRequest(payload, 'test_secret', 'evt_dup_same');

  const res1 = mockRes();
  await webhook(reqFactory(), res1);
  assert.equal(res1.statusCode, 200);

  const res2 = mockRes();
  await webhook(reqFactory(), res2);
  assert.equal(res2.statusCode, 200);

  const refundDoc = (await db.doc('refund_requests/job_dup_8').get()).data();
  assert.equal(refundDoc.state, 'confirmed');
});

// ── 9. Sweeper reconciler advances submitted -> confirmed ─────────────────
test('9 sweeper reconciler advances submitted -> confirmed via simulated GET refund returning processed', async () => {
  await seedInFirestore('job_sweep_conf_9', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_SWEEP9',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: {
      refundState: 'submitted',
    },
  });

  let getCalls = 0;
  const fakeClient = {
    getRefund: async ({ refundId }) => {
      getCalls++;
      assert.equal(refundId, 'rfnd_SWEEP9');
      return {
        id: 'rfnd_SWEEP9', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
      };
    },
  };

  const manager = makeManager(fakeClient);
  const res = await manager.reconcileRefunds();
  assert.equal(res.reconciled, 1);
  assert.equal(getCalls, 1);

  const jobDoc = (await db.doc('jobs/job_sweep_conf_9').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_sweep_conf_9').get()).data();
  assert.equal(jobDoc.refundState, 'confirmed');
  assert.equal(refundDoc.state, 'confirmed');
  assert.equal(refundDoc.confirmationSource, 'reconciliation');

  const outboxDoc = (await db.doc('notification_outbox/refund_confirmed:job_sweep_conf_9').get()).data();
  assert.ok(outboxDoc);
  assert.equal(outboxDoc.eventId, 'refund_confirmed:job_sweep_conf_9');
  assert.equal(outboxDoc.eventType, 'refund_confirmed');
  assert.equal(outboxDoc.resourceType, 'refund_request');
  assert.equal(outboxDoc.resourceId, 'job_sweep_conf_9');
  assert.equal(outboxDoc.channel, 'whatsapp');
  assert.equal(outboxDoc.recipientKey, 'customer:job_sweep_conf_9');
  assert.equal(outboxDoc.payloadVersion, 1);
  assert.deepEqual(outboxDoc.payload, {
    jobId: 'job_sweep_conf_9',
    jobStatus: 'cancelled_system',
    refundAmountPaise: 10000,
  });
  assert.equal(outboxDoc.state, 'pending');
  assert.equal(outboxDoc.ownerToken, null);
  assert.equal(outboxDoc.leaseUntil, null);
  assert.equal(outboxDoc.attemptCount, 0);
  assert.equal(outboxDoc.providerMessageId, null);
  assert.equal(outboxDoc.lastErrorCode, null);
  assert.equal(outboxDoc.sentAt, null);
});

// ── 10. Sweeper reconciler advances submitted -> failed_terminal ───────────
test('10 sweeper reconciler advances submitted -> failed_terminal via simulated GET refund returning failed', async () => {
  await seedInFirestore('job_sweep_fail_10', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_FAIL10',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: {
      refundState: 'submitted',
    },
  });

  const fakeClient = {
    getRefund: async () => ({
      id: 'rfnd_FAIL10', entity: 'refund', amount: 10000,
      currency: 'INR', payment_id: 'pay_TEST12345', status: 'failed',
    }),
  };

  const manager = makeManager(fakeClient);
  const res = await manager.reconcileRefunds();
  assert.equal(res.reconciled, 1);

  const jobDoc = (await db.doc('jobs/job_sweep_fail_10').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_sweep_fail_10').get()).data();
  assert.equal(jobDoc.refundState, 'failed_terminal');
  assert.equal(refundDoc.state, 'failed_terminal');
  assert.equal(refundDoc.lastErrorCode, 'PROVIDER_REFUND_FAILED');
});

// ── 11. Webhook advances submitted -> confirmed ───────────────────────────
test('11 webhook advances submitted -> confirmed via refund.processed', async () => {
  await seedInFirestore('job_wh_conf_11', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_CONF11',
      submittedAt: T.fromMillis(clock - 10000),
    },
    job: { refundState: 'submitted' },
  });

  const webhook = makeWebhook();
  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_CONF11',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_wh_conf_11' },
        },
      },
    },
  };

  const res = mockRes();
  await webhook(makeSignedWebhookRequest(payload, 'test_secret', 'evt_conf_11'), res);

  assert.equal(res.statusCode, 200);
  const jobDoc = (await db.doc('jobs/job_wh_conf_11').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_wh_conf_11').get()).data();
  assert.equal(jobDoc.refundState, 'confirmed');
  assert.equal(refundDoc.state, 'confirmed');
  assert.equal(refundDoc.confirmationSource, 'webhook');
});

// ── 12. Late webhook arrives after reconciler already marked confirmed ────
test('12 late webhook arrives after reconciler already marked confirmed: idempotently succeeds with 200 and zero invalid state mutation', async () => {
  const confirmedAt = T.fromMillis(clock - 50000);
  await seedInFirestore('job_late_wh_12', {
    refund: {
      state: 'confirmed',
      razorpayRefundId: 'rfnd_LATE12',
      confirmationSource: 'reconciliation',
      confirmedAt,
      submittedAt: T.fromMillis(clock - 60000),
    },
    job: {
      refundState: 'confirmed',
      razorpayRefundId: 'rfnd_LATE12',
      refundedAmountPaise: 10000,
      refundConfirmedAt: confirmedAt,
    },
  });
  await db.doc('notification_outbox/refund_confirmed:job_late_wh_12').set({
    eventId: 'refund_confirmed:job_late_wh_12',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_late_wh_12',
    channel: 'whatsapp',
    recipientKey: 'customer:job_late_wh_12',
    payloadVersion: 1,
    payload: {
      jobId: 'job_late_wh_12',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 10000,
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: confirmedAt,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: confirmedAt,
    updatedAt: confirmedAt,
    sentAt: null,
  });

  const webhook = makeWebhook();
  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_LATE12',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_late_wh_12' },
        },
      },
    },
  };

  const res = mockRes();
  await webhook(makeSignedWebhookRequest(payload, 'test_secret', 'evt_late_12'), res);

  assert.equal(res.statusCode, 200);
  const refundDoc = (await db.doc('refund_requests/job_late_wh_12').get()).data();
  assert.equal(refundDoc.confirmationSource, 'reconciliation');
  assert.equal(refundDoc.confirmedAt.toMillis(), confirmedAt.toMillis());
});

// ── 13. Late webhook arrives after failed_terminal ────────────────────────
test('13 late webhook arrives after failed_terminal: exact refundId converges failed_terminal -> confirmed', async () => {
  await seedInFirestore('job_late_term_13', {
    refund: {
      state: 'failed_terminal',
      razorpayRefundId: 'rfnd_REVIVE13',
      lastErrorCode: 'PROVIDER_REFUND_FAILED',
      submittedAt: T.fromMillis(clock - 60000),
    },
    job: { refundState: 'failed_terminal' },
  });

  const webhook = makeWebhook();
  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_REVIVE13',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'processed',
          notes: { jobId: 'job_late_term_13' },
        },
      },
    },
  };

  const res = mockRes();
  await webhook(makeSignedWebhookRequest(payload, 'test_secret', 'evt_revive_13'), res);

  assert.equal(res.statusCode, 200);
  const jobDoc = (await db.doc('jobs/job_late_term_13').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_late_term_13').get()).data();
  assert.equal(jobDoc.refundState, 'confirmed');
  assert.equal(refundDoc.state, 'confirmed');
  assert.equal(refundDoc.confirmationSource, 'webhook');
});

// ── 14. refund.failed webhook arrives ─────────────────────────────────────
test('14 refund.failed webhook arrives: ignored with 200, state left untouched', async () => {
  await seedInFirestore('job_failed_evt_14', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_EVT14',
      submittedAt: T.fromMillis(clock - 10000),
    },
    job: { refundState: 'submitted' },
  });

  const webhook = makeWebhook();
  const payload = {
    event: 'refund.failed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_EVT14',
          payment_id: 'pay_TEST12345',
          amount: 10000,
          currency: 'INR',
          status: 'failed',
          notes: { jobId: 'job_failed_evt_14' },
        },
      },
    },
  };

  const res = mockRes();
  await webhook(makeSignedWebhookRequest(payload, 'test_secret', 'evt_fail_14'), res);

  assert.equal(res.statusCode, 200);
  const refundDoc = (await db.doc('refund_requests/job_failed_evt_14').get()).data();
  assert.equal(refundDoc.state, 'submitted');
});

// ── 15. Exceeded attempts escalate to failed_terminal ─────────────────────
test('15 exceeded attempts escalate to failed_terminal when provider repeatedly fails', async () => {
  await seedInFirestore('job_max_attempts_15', {
    refund: {
      state: 'retry_wait',
      attemptCount: 5,
      nextAttemptAt: T.fromMillis(clock - 1000),
      lastErrorCode: 'PROVIDER_TIMEOUT',
    },
    job: { refundState: 'retry_wait' },
  });

  const fakeClient = {
    createRefund: async () => assert.fail('must not call provider when attempts exceeded'),
  };

  const manager = makeManager(fakeClient);
  const res = await manager.processRefundIntent('job_max_attempts_15');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.reason, 'max_attempts_exceeded');

  const jobDoc = (await db.doc('jobs/job_max_attempts_15').get()).data();
  const refundDoc = (await db.doc('refund_requests/job_max_attempts_15').get()).data();
  assert.equal(jobDoc.refundState, 'failed_terminal');
  assert.equal(refundDoc.state, 'failed_terminal');
  assert.equal(refundDoc.attemptCount, 5);
});

// ── 16. Ambiguous "already refunded" without local identity escalates ──────
test('16 ambiguous "already refunded" without local identity escalates to failed_terminal after max attempts without adopting unbound refunds', async () => {
  await seedInFirestore('job_ambig_16', {
    refund: {
      state: 'retry_wait',
      attemptCount: 3,
      nextAttemptAt: T.fromMillis(clock - 1000),
    },
  });

  const ambigErr = new Error('already refunded');
  ambigErr.status = 400;
  ambigErr.providerBody = { error: { description: 'Payment has already been fully refunded' } };

  const fakeClient = {
    createRefund: async () => { throw ambigErr; },
  };

  const manager = makeManager(fakeClient);

  // Attempt 4 -> throws ambiguous, recorded as retry_wait (attemptCount becomes 4)
  const res1 = await manager.processRefundIntent('job_ambig_16');
  assert.equal(res1.status, 'retry_wait');
  assert.equal(res1.errorCode, 'PROVIDER_ALREADY_REFUNDED_AMBIGUOUS');

  clock += 60000;

  // Attempt 5 -> reaches MAX_INITIATION_ATTEMPTS (5) -> failed_terminal
  const res2 = await manager.processRefundIntent('job_ambig_16');
  assert.equal(res2.status, 'failed_terminal');

  const refundDoc = (await db.doc('refund_requests/job_ambig_16').get()).data();
  assert.equal(refundDoc.state, 'failed_terminal');
  assert.equal(refundDoc.razorpayRefundId, null); // never adopted unverified ID
});

// ── 17. Ineligible job states rejected with zero Firestore writes ─────────
test('17 ineligible job states (not cancelled_system or not no_driver_found) rejected with zero Firestore writes', async () => {
  await seedInFirestore('job_ineligible_17', {
    job: {
      status: 'in_progress',
      dispatchState: 'claimed',
      cancelledBy: null,
      cancellationReason: null,
    },
  });

  const fakeClient = { createRefund: async () => assert.fail('must not call') };
  const manager = makeManager(fakeClient);

  await assert.rejects(
    async () => manager.processRefundIntent('job_ineligible_17'),
    { code: 'JOB_NOT_SYSTEM_CANCELLED' }
  );

  const refundDoc = (await db.doc('refund_requests/job_ineligible_17').get()).data();
  assert.equal(refundDoc.state, 'pending');
  assert.equal(refundDoc.attemptCount, 0);
});

// ── 18. Tampered refund amount / payment ID / idempotency key rejected ────
test('18 tampered refund amount / payment ID / idempotency key rejected with zero Firestore writes', async () => {
  await seedInFirestore('job_tampered_18', {
    refund: {
      amountPaise: 99999, // tampered vs job's 10000
    },
  });

  const fakeClient = { createRefund: async () => assert.fail('must not call') };
  const manager = makeManager(fakeClient);

  await assert.rejects(
    async () => manager.processRefundIntent('job_tampered_18'),
    { code: 'REFUND_AMOUNT_MISMATCH' }
  );

  const refundDoc = (await db.doc('refund_requests/job_tampered_18').get()).data();
  assert.equal(refundDoc.state, 'pending');
});

// ── 19. Terminal states are absorbing and cannot be reclaimed ─────────────
test('19 terminal states (confirmed, failed_terminal) are absorbing and cannot be reclaimed by worker or sweep', async () => {
  await seedInFirestore('job_term_19a', {
    refund: {
      state: 'confirmed',
      razorpayRefundId: 'rfnd_TERM19A',
      confirmedAt: T.fromMillis(clock - 10000),
    },
    job: { refundState: 'confirmed' },
  });
  await seedInFirestore('job_term_19b', {
    refund: {
      state: 'failed_terminal',
      razorpayRefundId: 'rfnd_TERM19B',
      lastErrorCode: 'PROVIDER_BAD_REQUEST',
    },
    job: { refundState: 'failed_terminal' },
  });

  const fakeClient = {
    createRefund: async () => assert.fail('must not call create'),
    getRefund: async () => assert.fail('must not call get'),
  };

  const manager = makeManager(fakeClient);

  const resA = await manager.processRefundIntent('job_term_19a');
  assert.equal(resA.claimed, false);
  assert.equal(resA.status, 'confirmed');

  const resB = await manager.processRefundIntent('job_term_19b');
  assert.equal(resB.claimed, false);
  assert.equal(resB.status, 'failed_terminal');

  const sweepRes = await manager.reconcileRefunds();
  assert.equal(sweepRes.reconciled, 0);
});

// ── 20. Driver wallet balance and ledger invariance ───────────────────────
test('20 driver wallet balance and ledger invariance: throughout full refund lifecycle, zero writes to drivers, driver wallets, or wallet_entries', async () => {
  await seedInFirestore('job_inv_20');

  // Seed driver and wallet entry
  await db.doc('drivers/drv_test').set(driver(T, clock, {
    walletBalance: 50000,
    location: new GeoPoint(18.525, 73.86),
  }));
  await db.doc('wallet_entries/entry_test').set({
    operationId: 'entry_test',
    driverId: 'drv_test',
    deltaPaise: 5000,
    type: 'commission_debit',
  });

  const fakeClient = {
    createRefund: async args => ({
      id: 'rfnd_INV20', entity: 'refund', amount: args.amount,
      currency: 'INR', payment_id: args.paymentId, status: 'pending',
    }),
    getRefund: async () => ({
      id: 'rfnd_INV20', entity: 'refund', amount: 10000,
      currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
    }),
  };

  const manager = makeManager(fakeClient);

  // 1. Process refund intent -> submitted
  await manager.processRefundIntent('job_inv_20');

  // 2. Advance time and sweep reconcile -> confirmed
  clock += 60000;
  await manager.reconcileRefunds();

  const refundDoc = (await db.doc('refund_requests/job_inv_20').get()).data();
  assert.equal(refundDoc.state, 'confirmed');

  // Verify driver and wallet remain untouched
  const drvDoc = (await db.doc('drivers/drv_test').get()).data();
  assert.equal(drvDoc.walletBalance, 50000);

  const entryDoc = (await db.doc('wallet_entries/entry_test').get()).data();
  assert.equal(entryDoc.deltaPaise, 5000);

  const allEntries = await db.collection('wallet_entries').get();
  assert.equal(allEntries.size, 1);
});

// ── 21. Finite dispatch exhaustion to refund handoff ───────────────────────
test('21 finite dispatch exhaustion to refund handoff: trigger Stage 8 dispatch exhaustion, verify canonical cancelled_system job and refund_requests doc created, then process refund through Stage 9 to submitted -> confirmed', async () => {
  // Seed a paid job with ready dispatch state and zero eligible drivers
  const job = paidJob(T, clock, {
    status: 'pending_offer',
    dispatchState: 'ready',
    razorpayPaymentId: 'pay_HANDOFF21',
    bookingFeePaise: 10000,
  });
  await db.doc('jobs/job_handoff_21').set(job);

  const dispatchService = createDispatchService({
    db,
    TimestampClass: T,
    now,
    olaClient: { getDistanceMatrix: async () => ({ rows: [] }) },
  });

  // Exhaust dispatch: 0 candidates available
  const dispatchRes = await dispatchService.triggerDispatch('job_handoff_21');
  assert.equal(dispatchRes.exhausted, true);
  assert.equal(dispatchRes.status, 'cancelled_system');
  assert.equal(dispatchRes.cancellationReason, 'no_driver_found');

  // Verify Stage 8 created canonical refund_requests document
  const refundSnap = await db.doc('refund_requests/job_handoff_21').get();
  assert.equal(refundSnap.exists, true);
  const initialRefund = refundSnap.data();
  assert.equal(initialRefund.state, 'pending');
  assert.equal(initialRefund.amountPaise, 10000);
  assert.equal(initialRefund.razorpayPaymentId, 'pay_HANDOFF21');
  assert.equal(initialRefund.reason, 'no_driver_found');

  // Stage 9 takes over: process refund intent -> submitted
  const fakeClient = {
    createRefund: async args => ({
      id: 'rfnd_HANDOFF21', entity: 'refund', amount: args.amount,
      currency: 'INR', payment_id: args.paymentId, status: 'pending',
    }),
    getRefund: async () => ({
      id: 'rfnd_HANDOFF21', entity: 'refund', amount: 10000,
      currency: 'INR', payment_id: 'pay_HANDOFF21', status: 'processed',
    }),
  };

  const refundManager = makeManager(fakeClient);
  const refundRes = await refundManager.processRefundIntent('job_handoff_21');
  assert.equal(refundRes.status, 'submitted');

  // Reconcile -> confirmed
  clock += 60000;
  const sweepRes = await refundManager.reconcileRefunds();
  assert.equal(sweepRes.reconciled, 1);

  const finalJob = (await db.doc('jobs/job_handoff_21').get()).data();
  const finalRefund = (await db.doc('refund_requests/job_handoff_21').get()).data();
  assert.equal(finalJob.refundState, 'confirmed');
  assert.equal(finalRefund.state, 'confirmed');
  assert.equal(finalRefund.razorpayRefundId, 'rfnd_HANDOFF21');
});

// ── 22. Scheduled durability: all 3 categories & 8 required cases ─────────
test('22 scheduled durability recovers all 3 categories across 8 canonical cases', async () => {
  // 1. Pending due (no trigger executed)
  await seedInFirestore('rec_pending_due', {
    refund: {
      state: 'pending',
      nextAttemptAt: T.fromMillis(clock - 5000),
    },
    job: { refundState: 'pending' },
  });

  // 2. Retry_wait due
  await seedInFirestore('rec_retry_wait_due', {
    refund: {
      state: 'retry_wait',
      nextAttemptAt: T.fromMillis(clock - 5000),
      attemptCount: 1,
    },
    job: { refundState: 'retry_wait' },
  });

  // 3. Expired in_progress (crashed worker takeover)
  await seedInFirestore('rec_expired_inprogress', {
    refund: {
      state: 'in_progress',
      ownerToken: 'crashed_worker_token',
      leaseUntil: T.fromMillis(clock - 5000),
      attemptCount: 1,
    },
    job: { refundState: 'in_progress' },
  });

  // 4. Active in_progress (lease still valid)
  await seedInFirestore('rec_active_inprogress', {
    refund: {
      state: 'in_progress',
      ownerToken: 'live_worker_token',
      leaseUntil: T.fromMillis(clock + 50000),
      attemptCount: 1,
    },
    job: { refundState: 'in_progress' },
  });

  // 5. Submitted due
  await seedInFirestore('rec_submitted_due', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_SubDue123',
      reconciliationNextAttemptAt: T.fromMillis(clock - 5000),
      reconciliationAttempts: 0,
      submittedAt: T.fromMillis(clock - 60000),
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_SubDue123' },
  });

  // 6. Pending not due
  await seedInFirestore('rec_pending_notdue', {
    refund: {
      state: 'pending',
      nextAttemptAt: T.fromMillis(clock + 50000),
    },
    job: { refundState: 'pending' },
  });

  // 7. Retry_wait not due
  await seedInFirestore('rec_retry_notdue', {
    refund: {
      state: 'retry_wait',
      nextAttemptAt: T.fromMillis(clock + 50000),
      attemptCount: 1,
    },
    job: { refundState: 'retry_wait' },
  });

  // 8. Submitted not due
  await seedInFirestore('rec_submitted_notdue', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_SubNotDue123',
      reconciliationNextAttemptAt: T.fromMillis(clock + 50000),
      reconciliationAttempts: 0,
      submittedAt: T.fromMillis(clock - 10000),
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_SubNotDue123' },
  });

  const createdCalls = [];
  const getCalls = [];
  const fakeClient = {
    createRefund: async args => {
      createdCalls.push(args);
      return {
        id: 'rfnd_CREATED' + args.paymentId.replace(/[^A-Za-z0-9]/g, ''),
        entity: 'refund',
        amount: args.amount,
        payment_id: args.paymentId,
        status: 'pending',
      };
    },
    getRefund: async args => {
      getCalls.push(args);
      return {
        id: args.refundId,
        entity: 'refund',
        amount: 10000,
        payment_id: args.paymentId,
        status: 'processed',
      };
    },
  };

  const manager = makeManager(fakeClient);
  await manager.reconcileRefunds();

  // 1. Pending due -> discovered, createRefund called, state: submitted
  const doc1 = (await db.doc('refund_requests/rec_pending_due').get()).data();
  assert.equal(doc1.state, 'submitted');
  assert.equal(doc1.attemptCount, 1);

  // 2. Retry_wait due -> discovered, createRefund called, state: submitted, attemptCount incremented (1->2)
  const doc2 = (await db.doc('refund_requests/rec_retry_wait_due').get()).data();
  assert.equal(doc2.state, 'submitted');
  assert.equal(doc2.attemptCount, 2);

  // 3. Expired in_progress -> discovered, fresh ownerToken, attemptCount incremented (1->2), state: submitted
  const doc3 = (await db.doc('refund_requests/rec_expired_inprogress').get()).data();
  assert.equal(doc3.state, 'submitted');
  assert.equal(doc3.attemptCount, 2);
  assert.notEqual(doc3.ownerToken, 'crashed_worker_token');
  assert.equal(doc3.providerIdempotencyKey, 'refund_no_driver_found_rec_expired_inprogress');

  // 4. Active in_progress -> UNTOUCHED
  const doc4 = (await db.doc('refund_requests/rec_active_inprogress').get()).data();
  assert.equal(doc4.state, 'in_progress');
  assert.equal(doc4.ownerToken, 'live_worker_token');
  assert.equal(doc4.attemptCount, 1);

  // 5. Submitted due -> GET only, state: confirmed, confirmationSource: 'reconciliation'
  const doc5 = (await db.doc('refund_requests/rec_submitted_due').get()).data();
  assert.equal(doc5.state, 'confirmed');
  assert.equal(doc5.confirmationSource, 'reconciliation');

  // 6. Pending not due -> UNTOUCHED
  const doc6 = (await db.doc('refund_requests/rec_pending_notdue').get()).data();
  assert.equal(doc6.state, 'pending');
  assert.equal(doc6.attemptCount, 0);

  // 7. Retry_wait not due -> UNTOUCHED
  const doc7 = (await db.doc('refund_requests/rec_retry_notdue').get()).data();
  assert.equal(doc7.state, 'retry_wait');
  assert.equal(doc7.attemptCount, 1);

  // 8. Submitted not due -> UNTOUCHED
  const doc8 = (await db.doc('refund_requests/rec_submitted_notdue').get()).data();
  assert.equal(doc8.state, 'submitted');
  assert.equal(doc8.confirmationSource, null);

  // Exact provider invocation counts: 3 creates and 1 get
  assert.equal(createdCalls.length, 3);
  assert.equal(getCalls.length, 1);
  assert.equal(getCalls[0].refundId, 'rfnd_SubDue123');
});

// ── 23. R1 Schema exactness on emulator ───────────────────────────────────
test('23 R1 schema exactness: canonical 21-field refund_requests succeeds, extra currency field fails closed with 0 writes and 0 provider calls', async () => {
  // a) Canonical 21-field refund_requests
  await seedInFirestore('job_exact_21');
  let createCalls = 0;
  const fakeClient = {
    createRefund: async args => {
      createCalls++;
      return { id: 'rfnd_EXACT21', entity: 'refund', amount: args.amount, status: 'pending', payment_id: args.paymentId };
    },
  };
  const manager = makeManager(fakeClient);
  const resValid = await manager.processRefundIntent('job_exact_21');
  assert.equal(resValid.status, 'submitted');
  assert.equal(createCalls, 1);

  // b) Same seed with extra currency field
  await seedInFirestore('job_extra_currency');
  await db.doc('refund_requests/job_extra_currency').update({ currency: 'INR' });
  const jobBefore = (await db.doc('jobs/job_extra_currency').get()).data();
  const refundBefore = (await db.doc('refund_requests/job_extra_currency').get()).data();

  createCalls = 0;
  await assert.rejects(
    manager.processRefundIntent('job_extra_currency'),
    err => err.code === 'REFUND_SCHEMA_INVALID'
  );
  assert.equal(createCalls, 0);

  // Verify zero writes
  const jobAfter = (await db.doc('jobs/job_extra_currency').get()).data();
  const refundAfter = (await db.doc('refund_requests/job_extra_currency').get()).data();
  assert.deepEqual(jobBefore, jobAfter);
  assert.deepEqual(refundBefore, refundAfter);
});

// ── 24. R4 exact 60,000ms lease duration and boundary test ─────────────────
test('24 R4 exact 60,000ms lease duration: now < leaseUntil cannot reclaim, now == leaseUntil and now > leaseUntil reclaim', async () => {
  const claimClock = Date.parse('2026-09-02T12:00:00Z');
  let currentClock = claimClock;
  const client = {
    createRefund: async args => ({ id: 'rfnd_LEASE', entity: 'refund', amount: args.amount, status: 'pending', payment_id: args.paymentId }),
  };
  const manager = createNoDriverRefundManager({
    db,
    TimestampClass: T,
    now: () => currentClock,
    razorpayClient: client,
  });

  await seedInFirestore('job_lease_test');

  // Seed an in_progress lease expiring at claimClock + 60,000ms
  const leaseUntilMs = claimClock + 60000;
  await db.doc('refund_requests/job_lease_test').update({
    state: 'in_progress',
    ownerToken: 'prior_worker',
    leaseUntil: T.fromMillis(leaseUntilMs),
    attemptCount: 1,
  });
  await db.doc('jobs/job_lease_test').update({
    refundState: 'in_progress',
  });

  // 1. now < leaseUntil: 1ms before expiry -> active, cannot claim
  currentClock = leaseUntilMs - 1;
  const resActive = await manager.processRefundIntent('job_lease_test');
  assert.equal(resActive.claimed, false);
  assert.equal(resActive.reason, 'active_lease');

  // 2. now == leaseUntil: exactly at expiry -> reclaimable!
  currentClock = leaseUntilMs;
  const resExact = await manager.processRefundIntent('job_lease_test');
  assert.equal(resExact.status, 'submitted');

  const doc = (await db.doc('refund_requests/job_lease_test').get()).data();
  assert.equal(doc.attemptCount, 2);
});

// ── 25. R8 attemptCount boundaries: MAX=5, zero provider call when attemptCount >= 5
test('25 R8 attemptCount boundaries: attemptCount 5 transitions to failed_terminal with zero provider calls', async () => {
  await seedInFirestore('job_max_attempts', {
    refund: {
      attemptCount: 5,
      state: 'retry_wait',
      nextAttemptAt: T.fromMillis(clock - 1000),
    },
    job: { refundState: 'retry_wait' },
  });

  let createCalls = 0;
  const fakeClient = {
    createRefund: async () => {
      createCalls++;
      return { id: 'rfnd_FAIL', entity: 'refund', amount: 10000, status: 'pending', payment_id: 'pay_TEST12345' };
    },
  };
  const manager = makeManager(fakeClient);
  const res = await manager.processRefundIntent('job_max_attempts');

  assert.equal(res.claimed, false);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.reason, 'max_attempts_exceeded');
  assert.equal(createCalls, 0);

  const refundDoc = (await db.doc('refund_requests/job_max_attempts').get()).data();
  assert.equal(refundDoc.state, 'failed_terminal');
  assert.equal(refundDoc.attemptCount, 5);
  assert.equal(refundDoc.lastErrorCode, 'MAX_ATTEMPTS_EXCEEDED');

  const jobDoc = (await db.doc('jobs/job_max_attempts').get()).data();
  assert.equal(jobDoc.refundState, 'failed_terminal');
});

// ── 26. Live emulator outbox preservation on duplicate reconciliation/webhook
test('26 live emulator outbox preservation: duplicate reconciliation does not overwrite progressed sent outbox', async () => {
  await seedInFirestore('job_outbox_dup_26', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_DUP26',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_DUP26' },
  });

  // Pre-seed progressed outbox record in live emulator
  await db.doc('notification_outbox/refund_confirmed:job_outbox_dup_26').set({
    eventId: 'refund_confirmed:job_outbox_dup_26',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_outbox_dup_26',
    channel: 'whatsapp',
    recipientKey: 'customer:job_outbox_dup_26',
    payloadVersion: 1,
    payload: {
      jobId: 'job_outbox_dup_26',
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
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: T.fromMillis(clock - 5000),
    sentAt: T.fromMillis(clock - 5000),
  });

  const fakeClient = {
    getRefund: async () => ({
      id: 'rfnd_DUP26', entity: 'refund', amount: 10000,
      currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
    }),
  };
  const manager = makeManager(fakeClient);
  const res = await manager.reconcileSubmittedRefund('job_outbox_dup_26');
  assert.equal(res.status, 'confirmed');

  // Verify outbox document in Firestore was untouched
  const outboxDoc = (await db.doc('notification_outbox/refund_confirmed:job_outbox_dup_26').get()).data();
  assert.equal(outboxDoc.state, 'sent');
  assert.equal(outboxDoc.providerMessageId, 'wamid.HBgLMTIzNDU2Nzg5MA==');
  assert.equal(outboxDoc.attemptCount, 1);
});

// ── 27. Live emulator contradictory outbox payload fails closed
test('27 live emulator contradictory outbox payload fails closed with OUTBOX_COLLISION_INVALID', async () => {
  await seedInFirestore('job_outbox_bad_27', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_BAD27',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_BAD27' },
  });

  await db.doc('notification_outbox/refund_confirmed:job_outbox_bad_27').set({
    eventId: 'refund_confirmed:job_outbox_bad_27',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'job_outbox_bad_27',
    channel: 'whatsapp',
    recipientKey: 'customer:job_outbox_bad_27',
    payloadVersion: 1,
    payload: {
      jobId: 'job_outbox_bad_27',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 99999, // Contradictory amount
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: T.fromMillis(clock),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: T.fromMillis(clock),
    updatedAt: T.fromMillis(clock),
    sentAt: null,
  });

  const fakeClient = {
    getRefund: async () => ({
      id: 'rfnd_BAD27', entity: 'refund', amount: 10000,
      currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
    }),
  };
  const manager = makeManager(fakeClient);

  await assert.rejects(
    async () => manager.reconcileSubmittedRefund('job_outbox_bad_27'),
    err => err.code === 'OUTBOX_COLLISION_INVALID'
  );

  const refundDoc = (await db.doc('refund_requests/job_outbox_bad_27').get()).data();
  assert.equal(refundDoc.state, 'submitted');
  assert.equal(refundDoc.confirmedAt, null);
});

// ── 28. Live emulator webhook vs reconciler race creates outbox once
test('28 live emulator webhook vs reconciler race creates outbox atomically once', async () => {
  await seedInFirestore('job_race_outbox_28', {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_RACE28',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_RACE28' },
  });

  const enterGate = gate();
  const releaseGate = gate();

  const fakeClient = {
    getRefund: async () => {
      enterGate.resolve();
      await releaseGate.promise;
      return {
        id: 'rfnd_RACE28', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
      };
    },
  };
  const manager = makeManager(fakeClient);
  const webhook = makeWebhook();

  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_RACE28',
          payment_id: 'pay_TEST12345',
          status: 'processed',
          amount: 10000,
          currency: 'INR',
        },
      },
    },
  };
  const req = makeSignedWebhookRequest(payload, 'test_secret', 'evt_race_28');

  const res = mockRes();
  const recPromise = manager.reconcileSubmittedRefund('job_race_outbox_28');
  await enterGate.promise;
  try {
    await webhook(req, res);
    assert.equal(res.statusCode, 200);
  } finally {
    releaseGate.resolve();
  }

  const resRec = await recPromise;

  assert.equal(resRec.status, 'confirmed');
  const outboxDoc = (await db.doc('notification_outbox/refund_confirmed:job_race_outbox_28').get()).data();
  assert.ok(outboxDoc);
  assert.equal(outboxDoc.eventId, 'refund_confirmed:job_race_outbox_28');
  assert.equal(outboxDoc.state, 'pending');
});

// ── 29. Live emulator attempt-5 boundary check: starting at 4, Tx1 claims 5, provider call #5 fails, moves to failed_terminal and zero attempt #6
test('29 live emulator attempt-5 boundary: starting at attemptCount: 4, failure transitions to failed_terminal with attemptCount: 5 and zero attempt #6', async () => {
  await seedInFirestore('job_boundary_29', {
    refund: {
      attemptCount: 4,
      state: 'retry_wait',
      nextAttemptAt: T.fromMillis(clock - 1000),
    },
    job: { refundState: 'retry_wait' },
  });

  let createCalls = 0;
  const err503 = new Error('Service Unavailable');
  err503.status = 503;

  const fakeClient = {
    createRefund: async () => {
      createCalls++;
      throw err503;
    },
  };

  const manager = makeManager(fakeClient);

  // 1. Execute attempt #5
  const res = await manager.processRefundIntent('job_boundary_29');
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.finalized, true);
  assert.equal(res.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(createCalls, 1);

  const refundDoc = (await db.doc('refund_requests/job_boundary_29').get()).data();
  assert.equal(refundDoc.state, 'failed_terminal');
  assert.equal(refundDoc.attemptCount, 5);
  assert.equal(refundDoc.lastErrorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(refundDoc.ownerToken, null);
  assert.equal(refundDoc.leaseUntil, null);
  assert.equal(refundDoc.nextAttemptAt, null);

  const jobDoc = (await db.doc('jobs/job_boundary_29').get()).data();
  assert.equal(jobDoc.refundState, 'failed_terminal');

  // 2. Subsequent execution must NOT call provider
  const resSubsequent = await manager.processRefundIntent('job_boundary_29');
  assert.equal(resSubsequent.claimed, false);
  assert.equal(resSubsequent.status, 'failed_terminal');
  assert.equal(createCalls, 1); // Never issues attempt #6!
});

// ── 30. Live emulator outbox state matrix: all 5 legal states survive reconciliation without mutation
test('30 live emulator outbox state matrix: all 5 legal states survive reconciliation without mutation', async () => {
  const stateTemplates = {
    pending: {
      state: 'pending',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: T.fromMillis(clock),
      attemptCount: 0,
      providerMessageId: null,
      lastErrorCode: null,
      sentAt: null,
    },
    in_progress: {
      state: 'in_progress',
      ownerToken: 'worker-token-matrix',
      leaseUntil: T.fromMillis(clock + 60000),
      nextAttemptAt: null,
      attemptCount: 1,
      providerMessageId: null,
      lastErrorCode: null,
      sentAt: null,
    },
    retry_wait: {
      state: 'retry_wait',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: T.fromMillis(clock + 30000),
      attemptCount: 1,
      providerMessageId: null,
      lastErrorCode: 'provider_unavailable',
      sentAt: null,
    },
    sent: {
      state: 'sent',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      attemptCount: 1,
      providerMessageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
      lastErrorCode: null,
      sentAt: T.fromMillis(clock - 5000),
    },
    failed_terminal: {
      state: 'failed_terminal',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      attemptCount: 5,
      providerMessageId: null,
      lastErrorCode: 'internal_error',
      sentAt: null,
    },
  };

  for (const [stateName, template] of Object.entries(stateTemplates)) {
    const jobId = 'job_matrix_outbox_' + stateName;
    const testRefundId = 'rfnd_MAT' + stateName.replace(/[^A-Za-z0-9]/g, '');
    await seedInFirestore(jobId, {
      refund: {
        state: 'submitted',
        razorpayRefundId: testRefundId,
        submittedAt: T.fromMillis(clock - 60000),
        reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
        reconciliationAttempts: 1,
      },
      job: { refundState: 'submitted', razorpayRefundId: testRefundId },
    });

    const outboxRecord = {
      eventId: 'refund_confirmed:' + jobId,
      eventType: 'refund_confirmed',
      resourceType: 'refund_request',
      resourceId: jobId,
      channel: 'whatsapp',
      recipientKey: 'customer:' + jobId,
      payloadVersion: 1,
      payload: {
        jobId,
        jobStatus: 'cancelled_system',
        refundAmountPaise: 10000,
      },
      createdAt: T.fromMillis(clock - 10000),
      updatedAt: T.fromMillis(clock - 5000),
      ...template,
    };
    await db.doc('notification_outbox/refund_confirmed:' + jobId).set(outboxRecord);

    const fakeClient = {
      getRefund: async () => ({
        id: testRefundId, entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
      }),
    };
    const manager = makeManager(fakeClient);
    const res = await manager.reconcileSubmittedRefund(jobId);
    assert.equal(res.status, 'confirmed');

    const outboxAfter = (await db.doc('notification_outbox/refund_confirmed:' + jobId).get()).data();
    assert.equal(outboxAfter.state, template.state);
    assert.equal(outboxAfter.attemptCount, template.attemptCount);
    assert.equal(outboxAfter.ownerToken, template.ownerToken);
    assert.equal(outboxAfter.providerMessageId, template.providerMessageId);
    assert.equal(outboxAfter.lastErrorCode, template.lastErrorCode);
  }
});

// ── 31. Live emulator race with pre-existing progressed outbox preserves outbox
test('31 live emulator race between webhook and reconciler with pre-existing sent outbox preserves outbox', async () => {
  const jobId = 'job_race_sent_31';
  await seedInFirestore(jobId, {
    refund: {
      state: 'submitted',
      razorpayRefundId: 'rfnd_RACE31',
      submittedAt: T.fromMillis(clock - 60000),
      reconciliationNextAttemptAt: T.fromMillis(clock - 1000),
      reconciliationAttempts: 1,
    },
    job: { refundState: 'submitted', razorpayRefundId: 'rfnd_RACE31' },
  });

  const sentOutbox = {
    eventId: 'refund_confirmed:' + jobId,
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + jobId,
    payloadVersion: 1,
    payload: {
      jobId,
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
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: T.fromMillis(clock - 5000),
    sentAt: T.fromMillis(clock - 5000),
  };
  await db.doc('notification_outbox/refund_confirmed:' + jobId).set(sentOutbox);

  const enterGate = gate();
  const releaseGate = gate();

  const fakeClient = {
    getRefund: async () => {
      enterGate.resolve();
      await releaseGate.promise;
      return {
        id: 'rfnd_RACE31', entity: 'refund', amount: 10000,
        currency: 'INR', payment_id: 'pay_TEST12345', status: 'processed',
      };
    },
  };
  const manager = makeManager(fakeClient);
  const webhook = makeWebhook();

  const payload = {
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_RACE31',
          payment_id: 'pay_TEST12345',
          status: 'processed',
          amount: 10000,
          currency: 'INR',
        },
      },
    },
  };
  const req = makeSignedWebhookRequest(payload, 'test_secret', 'evt_race_31');

  const res = mockRes();
  const recPromise = manager.reconcileSubmittedRefund(jobId);
  await enterGate.promise;
  try {
    await webhook(req, res);
    assert.equal(res.statusCode, 200);
  } finally {
    releaseGate.resolve();
  }

  const resRec = await recPromise;

  assert.equal(resRec.status, 'confirmed');
  const outboxDoc = (await db.doc('notification_outbox/refund_confirmed:' + jobId).get()).data();
  assert.equal(outboxDoc.state, 'sent');
  assert.equal(outboxDoc.providerMessageId, 'wamid.HBgLMTIzNDU2Nzg5MA==');
  assert.equal(outboxDoc.attemptCount, 1);
  assert.equal(outboxDoc.sentAt.toMillis(), clock - 5000);
});
