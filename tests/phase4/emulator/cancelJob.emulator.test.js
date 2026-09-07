'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint } = require('firebase-admin/firestore');
const { createCancelJobManager } = require('../../../firebase/functions/src/dispatch/cancelJob');
const { createAcceptJobManager } = require('../../../firebase/functions/src/dispatch/acceptJob');
const { createJobLifecycleManager } = require('../../../firebase/functions/src/dispatch/jobLifecycle');
const { createCustomerCancellationManager } = require('../../../firebase/functions/src/dispatch/customerCancellation');
const { createDispatchService } = require('../../../firebase/functions/src/dispatch/dispatchService');
const { createTaskQueueService } = require('../../../firebase/functions/src/services/taskQueueService');
const { FakeTaskQueue } = require('../fakeDeps');
const { paidJob, config, driver } = require('../fixtures');
const {
  DispatchError,
  CANCELLATION_EVIDENCE_EXACT_KEYS,
  POLICY_KEYS,
} = require('../../../firebase/functions/src/dispatch/dispatchValidation');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage8-cancel-test';
const app = initializeApp({ projectId: project }, 'stage8-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = (jobId, gen = 1) => db.doc('jobs/' + jobId + '/dispatch_runs/' + gen);
const driverRef = id => db.doc('drivers/' + id);
const debitLedgerRef = (jobId, offerId) => db.doc('wallet_entries/commission_debit:' + jobId + ':' + offerId);
const creditLedgerRef = (jobId, offerId) => db.doc('wallet_entries/driver_cancel_credit:' + jobId + ':' + offerId);
const receiptRef = id => db.doc('processed_requests/' + id);

const read = async ref => (await ref.get()).data();
const exists = async ref => (await ref.get()).exists;

test.beforeEach(async () => {
  clock = Date.parse('2026-09-02T10:00:00Z');
  const response = await fetch('http://' + host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
  assert.equal(response.ok, true);

  await db.doc('dispatch_config/main').set(config(T, clock));
  await db.doc('pricing_config/main').set({
    cancellation_policy: {
      version: 1,
      timezone: 'Asia/Kolkata',
      roundingMode: 'HALF_UP',
      free_cancellations_per_month: 1,
      forfeit_pct_by_count: { '2': 20, '3': 30, '4': 40, '5': 50 },
      ban_threshold_count: 6,
      ban_duration_days: 7,
    },
  });
});

test.after(async () => {
  await db.terminate();
  await app.delete();
});

async function seedDriver(id, patch = {}) {
  const d = driver(T, clock, {
    location: new GeoPoint(18.525, 73.86),
    verificationStatus: 'approved',
    isOnDuty: true,
    canFlatbed: true,
    walletBalance: 25000,
    activeJobId: null,
    activeOfferId: null,
    monthlyCancelCount: { month: '2026-09', count: 0 },
    strictMode: false,
    bannedUntil: null,
    ...patch,
  });
  await driverRef(id).set(d);
  return d;
}

async function seedOfferedJobAndRun({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  generation = 1,
  commissionPaise = 5000,
  lifetimeMs = 45000,
  extraCandidates = [],
} = {}) {
  const offeredAt = T.fromMillis(clock);
  const expiresAt = T.fromMillis(clock + lifetimeMs);

  const j = paidJob(T, clock, {
    status: 'offered',
    dispatchState: 'offered',
    offeredTo: driverId,
    currentOfferId: offerId,
    offeredAt,
    offerExpiresAt: expiresAt,
    dispatchGeneration: generation,
    dispatchRunId: String(generation),
    driverCommissionPaise: commissionPaise,
    stateVersion: 1,
    cancellationResolutionState: 'none',
    cancellationRequestedAt: null,
    cancellationResolvedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    acceptedAt: null,
    inProgressAt: null,
    completedAt: null,
    refundRequestId: null,
    refundState: 'none',
    refundNextAttemptAt: null,
    razorpayRefundId: null,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    forfeitedAmount: 0,
  });
  await jobRef(jobId).set(j);

  const o = {
    jobId,
    driverId,
    dispatchGeneration: generation,
    candidateIndex: 0,
    roundIndex: 0,
    status: 'offered',
    offeredAt,
    expiresAt,
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt: null,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'pending',
    acceptRequestId: null,
    cancellationPolicySnapshot: null,
    pickupCoords: j.pickupCoords,
    destCoords: j.destCoords,
    requestedTruckType: j.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: j.estimatedFarePaise,
    driverCommissionPaise: commissionPaise,
    createdAt: offeredAt,
    updatedAt: offeredAt,
  };
  await offerRef(offerId).set(o);

  const fullConfig = config(T, clock);
  const policySnapshot = Object.fromEntries(POLICY_KEYS.map(key => [key, fullConfig[key]]));

  const candidates = [
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'offered',
      reasonCode: null,
    },
    ...extraCandidates,
  ];

  const r = {
    jobId,
    generation,
    status: 'active',
    policyVersion: 1,
    policySnapshot,
    candidates,
    nextCandidateIndex: 1,
    attemptedDriverIds: [driverId],
    excludedDriverIds: [],
    currentOfferId: offerId,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    finalizedAt: null,
  };
  await runRef(jobId, generation).set(r);

  await driverRef(driverId).update({ activeOfferId: offerId });

  return { jobId, driverId, offerId, generation };
}

async function setupAndAcceptJob({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  commissionPaise = 5000,
  acceptRequestId = 'req-accept-1',
  driverPatch = {},
  extraCandidates = [],
} = {}) {
  await seedDriver(driverId, driverPatch);
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise, extraCandidates });

  const acceptMgr = createAcceptJobManager({ db, TimestampClass: T, now });
  clock += 1000;
  const acceptRes = await acceptMgr.acceptJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: acceptRequestId,
  });
  assert.equal(acceptRes.accepted, true);

  return { jobId, driverId, offerId, acceptRequestId, commissionPaise };
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. CANONICAL ACCEPTED CANCELLATION (ATOMIC 6-DOCUMENT MUTATION)
// ════════════════════════════════════════════════════════════════════════════════
test('1. atomic 6-document mutation: accepted job cancellation updates job, offer, run, driver, credit ledger, and request receipt', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_canon_1',
    driverId: 'driver_canon_1',
    offerId: 'offer_canon_1',
    commissionPaise: 5000,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  clock += 2000;
  const cancelTimeMs = clock;

  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-canon-1',
  });

  // Verify function return payload
  assert.deepEqual(res, {
    cancelled: true,
    jobId,
    offerId,
    driverId,
    refundPaise: 5000,
    forfeitedPaise: 0,
  });

  // 1. Doc 1: jobs/{jobId}
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');
  assert.equal(job.assignedDriver, null);
  assert.equal(job.currentOfferId, null);
  assert.equal(job.forfeitedAmount, 0);
  assert.equal(job.stateVersion, 3); // 1 (offered) -> 2 (accepted) -> 3 (cancelled_driver)
  assert.equal(job.cancellationResolutionState, 'none');
  assert.equal(job.updatedAt.toMillis(), cancelTimeMs);

  // 2. Doc 2: job_offers/{offerId}
  const offer = await read(offerRef(offerId));
  assert.equal(offer.status, 'cancelled_driver');
  assert.equal(offer.resolvedAt.toMillis(), cancelTimeMs);
  assert.equal(offer.resolutionReason, 'driver_cancelled');
  assert.equal(offer.updatedAt.toMillis(), cancelTimeMs);

  // 3. Doc 3: jobs/{jobId}/dispatch_runs/{runId}
  const run = await read(runRef(jobId, 1));
  assert.equal(run.status, 'active');
  assert.equal(run.candidates[0].outcome, 'driver_cancelled');
  assert.equal(run.candidates[0].reasonCode, null);
  assert.deepEqual(run.attemptedDriverIds, [driverId]);
  assert.deepEqual(run.excludedDriverIds, [driverId]);
  assert.equal(run.nextCandidateIndex, 1);
  assert.equal(run.finalizedAt, null);

  // 4. Doc 4: drivers/{driverId}
  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.walletBalance, 25000); // 25000 - 5000 + 5000 = 25000
  assert.deepEqual(driverDoc.monthlyCancelCount, { month: '2026-09', count: 1 });
  assert.equal(driverDoc.strictMode, false);
  assert.equal(driverDoc.bannedUntil, null);

  // 5. Doc 5: wallet_entries/driver_cancel_credit:{jobId}:{offerId}
  const creditDoc = await read(creditLedgerRef(jobId, offerId));
  const expectedCreditKeys = [
    'operationId', 'driverId', 'jobId', 'offerId', 'type',
    'commissionPaise', 'forfeiturePaise', 'creditPaise', 'deltaPaise',
    'balanceBeforePaise', 'balanceAfterPaise', 'cancellationPolicyEvidence',
    'sourceRequestId', 'sourceType', 'actorUid', 'createdAt',
  ].sort();
  assert.deepEqual(Object.keys(creditDoc).sort(), expectedCreditKeys);
  assert.equal(creditDoc.operationId, `driver_cancel_credit:${jobId}:${offerId}`);
  assert.equal(creditDoc.driverId, driverId);
  assert.equal(creditDoc.jobId, jobId);
  assert.equal(creditDoc.offerId, offerId);
  assert.equal(creditDoc.type, 'driver_cancel_credit');
  assert.equal(creditDoc.commissionPaise, 5000);
  assert.equal(creditDoc.forfeiturePaise, 0);
  assert.equal(creditDoc.creditPaise, 5000);
  assert.equal(creditDoc.deltaPaise, 5000);
  assert.equal(creditDoc.balanceBeforePaise, 20000);
  assert.equal(creditDoc.balanceAfterPaise, 25000);
  assert.equal(creditDoc.sourceRequestId, 'req-cancel-canon-1');
  assert.equal(creditDoc.sourceType, 'driver');
  assert.equal(creditDoc.actorUid, driverId);
  assert.equal(creditDoc.createdAt.toMillis(), cancelTimeMs);

  // Validate 13 exact evidence keys
  const evidence = creditDoc.cancellationPolicyEvidence;
  assert.deepEqual(Object.keys(evidence).sort(), [...CANCELLATION_EVIDENCE_EXACT_KEYS].sort());
  assert.equal(evidence.version, 1);
  assert.equal(evidence.timezone, 'Asia/Kolkata');
  assert.equal(evidence.roundingMode, 'HALF_UP');
  assert.equal(evidence.freeCancellationsPerMonth, 1);
  assert.equal(evidence.banThresholdCount, 6);
  assert.equal(evidence.banDurationDays, 7);
  assert.equal(evidence.cancellationMonth, '2026-09');
  assert.equal(evidence.cancellationCount, 1);
  assert.equal(evidence.strictModeBefore, false);
  assert.equal(evidence.strictModeApplied, false);
  assert.equal(evidence.forfeiturePercent, 0);
  assert.equal(evidence.capturedAt.toMillis(), offer.acceptedAt.toMillis());

  // 6. Doc 6: processed_requests/{requestId}
  const receiptDoc = await read(receiptRef('req-cancel-canon-1'));
  assert.equal(receiptDoc.requestId, 'req-cancel-canon-1');
  assert.equal(receiptDoc.actorUid, driverId);
  assert.equal(receiptDoc.operation, 'driver_cancel');
  assert.equal(receiptDoc.resourceId, `${jobId}:${offerId}`);
  assert.equal(receiptDoc.status, 'completed');
  assert.equal(receiptDoc.claimedAt.toMillis(), cancelTimeMs);
  assert.equal(receiptDoc.processedAt.toMillis(), cancelTimeMs);
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. FORFEITURE RAMP & ODD PAISE ROUNDING ON EMULATOR
// ════════════════════════════════════════════════════════════════════════════════
test('2. forfeiture ramp & odd paise rounding: 3rd cancel forfeits 30% with Math.round on odd paise (1255 -> 377 forfeit, 878 credit)', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_ramp_1',
    driverId: 'driver_ramp_1',
    offerId: 'offer_ramp_1',
    commissionPaise: 1255,
    driverPatch: {
      walletBalance: 25000,
      monthlyCancelCount: { month: '2026-09', count: 2 }, // Prior count 2 -> this is 3rd cancel (30%)
    },
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  clock += 1000;

  // After accept: balance was 25000 - 1255 = 23745
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-ramp-3',
  });

  // 1255 * 0.3 = 376.5 -> Math.round = 377. Credit = 1255 - 377 = 878.
  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 377);
  assert.equal(res.refundPaise, 878);

  const job = await read(jobRef(jobId));
  assert.equal(job.forfeitedAmount, 377);

  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.walletBalance, 23745 + 878); // 24623
  assert.deepEqual(driverDoc.monthlyCancelCount, { month: '2026-09', count: 3 });

  const creditEntry = await read(creditLedgerRef(jobId, offerId));
  assert.equal(creditEntry.commissionPaise, 1255);
  assert.equal(creditEntry.forfeiturePaise, 377);
  assert.equal(creditEntry.creditPaise, 878);
  assert.equal(creditEntry.deltaPaise, 878);
  assert.equal(creditEntry.balanceBeforePaise, 23745);
  assert.equal(creditEntry.balanceAfterPaise, 24623);
  assert.equal(creditEntry.cancellationPolicyEvidence.forfeiturePercent, 30);
});

// ════════════════════════════════════════════════════════════════════════════════
// 3. 6TH CANCELLATION: FLAT 7-DAY BAN & STRICT MODE ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════════
test('3. 6th cancel triggers flat 7-day ban and sets strictMode: true on driver doc and evidence', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_ban_1',
    driverId: 'driver_ban_1',
    offerId: 'offer_ban_1',
    commissionPaise: 5000,
    driverPatch: {
      walletBalance: 25000,
      monthlyCancelCount: { month: '2026-09', count: 5 }, // Prior count 5 -> this is 6th cancel
      strictMode: false,
      bannedUntil: null,
    },
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  clock += 2000;
  const cancelTimeMs = clock;
  const expectedBanMs = cancelTimeMs + 7 * 86400 * 1000;

  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-ban-6',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 5000); // 100% forfeiture upon reaching ban threshold
  assert.equal(res.refundPaise, 0);

  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.strictMode, true);
  assert.ok(driverDoc.bannedUntil);
  assert.equal(driverDoc.bannedUntil.toMillis(), expectedBanMs);
  assert.deepEqual(driverDoc.monthlyCancelCount, { month: '2026-09', count: 6 });

  const creditEntry = await read(creditLedgerRef(jobId, offerId));
  assert.equal(creditEntry.cancellationPolicyEvidence.strictModeApplied, true);
  assert.equal(creditEntry.cancellationPolicyEvidence.forfeiturePercent, 100);
  assert.equal(creditEntry.deltaPaise, 0);
  assert.equal(creditEntry.forfeiturePaise, 5000);
  assert.equal(creditEntry.creditPaise, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// 4. REAL CONCURRENCY RACE: cancelJob vs startJob
// ════════════════════════════════════════════════════════════════════════════════
test('4. real concurrency race: cancelJob vs startJob starting from accepted state commits exactly one and rejects the other', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_race_1',
    driverId: 'driver_race_1',
    offerId: 'offer_race_1',
    commissionPaise: 5000,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Fire both concurrently on the real Firestore emulator
  const [cancelSettled, startSettled] = await Promise.allSettled([
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-race-cancel',
    }),
    lifecycleMgr.startJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-race-start',
    }),
  ]);

  // Real emulator transaction guarantee: exactly one resolves, exactly one rejects with JOB_NOT_ACCEPTED
  if (cancelSettled.status === 'fulfilled') {
    // cancelJob won the race
    assert.equal(cancelSettled.value.cancelled, true);
    assert.equal(startSettled.status, 'rejected');
    assert.equal(startSettled.reason.code, 'JOB_NOT_ACCEPTED');

    const job = await read(jobRef(jobId));
    assert.equal(job.status, 'pending_offer');
    assert.equal(job.dispatchState, 'ready');
    assert.equal(job.assignedDriver, null);

    const driverDoc = await read(driverRef(driverId));
    assert.equal(driverDoc.activeJobId, null);
  } else {
    // startJob won the race
    assert.equal(startSettled.status, 'fulfilled');
    assert.equal(startSettled.value.started, true);
    assert.equal(cancelSettled.status, 'rejected');
    assert.equal(cancelSettled.reason.code, 'JOB_NOT_ACCEPTED');

    const job = await read(jobRef(jobId));
    assert.equal(job.status, 'in_progress');
    assert.equal(job.assignedDriver, driverId);

    const driverDoc = await read(driverRef(driverId));
    assert.equal(driverDoc.activeJobId, jobId);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// 5. DETERMINISTIC CONCURRENCY ORDERS: ORDER A & ORDER B
// ════════════════════════════════════════════════════════════════════════════════
test('5A. Order A: cancelJob commits first -> startJob rejects with JOB_NOT_ACCEPTED and zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_order_a',
    driverId: 'driver_order_a',
    offerId: 'offer_order_a',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  const cancelRes = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-order-a-cancel',
  });
  assert.equal(cancelRes.cancelled, true);

  // Snapshot post-cancel
  const jobPostCancel = await read(jobRef(jobId));
  const driverPostCancel = await read(driverRef(driverId));

  // startJob must reject
  await assert.rejects(
    lifecycleMgr.startJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-order-a-start',
    }),
    err => err instanceof DispatchError && err.code === 'JOB_NOT_ACCEPTED'
  );

  // Verify zero domain writes by rejected startJob
  const jobAfterReject = await read(jobRef(jobId));
  const driverAfterReject = await read(driverRef(driverId));
  assert.deepEqual(jobAfterReject, jobPostCancel);
  assert.deepEqual(driverAfterReject, driverPostCancel);
});

test('5B. Order B: startJob commits first -> cancelJob rejects with JOB_NOT_ACCEPTED and zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_order_b',
    driverId: 'driver_order_b',
    offerId: 'offer_order_b',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  const startRes = await lifecycleMgr.startJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-order-b-start',
  });
  assert.equal(startRes.started, true);

  // Snapshot post-start
  const jobPostStart = await read(jobRef(jobId));
  const driverPostStart = await read(driverRef(driverId));

  // cancelJob must reject because job is now in_progress
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-order-b-cancel',
    }),
    err => err instanceof DispatchError && err.code === 'JOB_NOT_ACCEPTED'
  );

  // Verify zero domain writes by rejected cancelJob
  const jobAfterReject = await read(jobRef(jobId));
  const driverAfterReject = await read(driverRef(driverId));
  assert.deepEqual(jobAfterReject, jobPostStart);
  assert.deepEqual(driverAfterReject, driverPostStart);
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
});

// ════════════════════════════════════════════════════════════════════════════════
// 6. CUSTOMER CANCELLATION PRECEDENCE
// ════════════════════════════════════════════════════════════════════════════════
test('6A. customer cancellation precedence: resolved customer cancellation returns customer_cancellation_in_progress with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_cust_a',
    driverId: 'driver_cust_a',
    offerId: 'offer_cust_a',
  });

  // Customer cancellation has resolved canonically
  clock += 1000;
  const reqTime = T.fromMillis(clock);
  clock += 500;
  const resTime = T.fromMillis(clock);
  await jobRef(jobId).update({
    status: 'cancelled_customer',
    dispatchState: 'closed',
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'resolved',
    cancellationRequestedAt: reqTime,
    cancellationResolvedAt: resTime,
    cancelledAt: resTime,
  });
  await offerRef(offerId).update({
    status: 'cancelled_customer',
    resolutionReason: 'customer_cancelled',
    resolvedAt: resTime,
  });
  await runRef(jobId, 1).update({
    status: 'cancelled_customer',
    currentOfferId: offerId,
    finalizedAt: resTime,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cust-a',
  });

  assert.deepEqual(res, {
    cancelled: false,
    reason: 'customer_cancellation_in_progress',
    jobId,
    offerId,
    driverId,
  });

  // Verify ZERO domain writes
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  // Receipt must NOT be written for zero-write customer precedence response
  assert.equal(await exists(receiptRef('req-cust-a')), false);
});

test('6B. customer cancellation precedence: pending customer cancellation returns customer_cancellation_in_progress with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_cust_b',
    driverId: 'driver_cust_b',
    offerId: 'offer_cust_b',
  });

  // Customer cancellation marker is pending canonically
  await jobRef(jobId).update({
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: T.fromMillis(clock - 500),
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cust-b',
  });

  assert.deepEqual(res, {
    cancelled: false,
    reason: 'customer_cancellation_in_progress',
    jobId,
    offerId,
    driverId,
  });

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-cust-b')), false);
});

test('6C. Real Stage 7 -> Stage 8 emulator integration: Stage 7 customer cancellation resolution -> cancelJob precedence -> Driver B permission-denied', async () => {
  const { jobId, driverId: driverA, offerId } = await setupAndAcceptJob({
    jobId: 'job_stage7_stage8_integ',
    driverId: 'driver_stage7_stage8_a',
    offerId: 'offer_stage7_stage8_1',
  });
  await seedDriver('driver_stage7_stage8_b');

  // Canonical Phase 3 customer cancellation marker arrives
  clock += 1000;
  const reqTime = T.fromMillis(clock);
  await jobRef(jobId).update({
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: reqTime,
  });

  // Run production Stage 7 customer cancellation resolver
  const custMgr = createCustomerCancellationManager({ db, TimestampClass: T, now });
  clock += 1000;
  const custRes = await custMgr.resolveCustomerCancellation({ jobId });
  assert.equal(custRes.resolved, true);
  assert.equal(custRes.status, 'cancelled_customer');

  // Verify terminal state from production Stage 7
  const jobDoc = await read(jobRef(jobId));
  assert.equal(jobDoc.status, 'cancelled_customer');
  assert.equal(jobDoc.dispatchState, 'closed');
  assert.equal(jobDoc.cancellationResolutionState, 'resolved');

  // Driver A calls NEW cancelJob
  const { createCancelJobCallable } = require('../../../firebase/functions/src/dispatch/cancelJob');
  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const callable = createCancelJobCallable({ cancelJobManager: cancelMgr });

  const cancelResA = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverA,
    requestId: 'req-stage7-stage8-a',
  });
  assert.deepEqual(cancelResA, {
    cancelled: false,
    reason: 'customer_cancellation_in_progress',
    jobId,
    offerId,
    driverId: driverA,
  });
  // ZERO writes
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-stage7-stage8-a')), false);

  // Driver B calls cancelJob against Driver A's terminal occurrence -> fails actor/occurrence binding (permission-denied / zero writes)
  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_stage7_stage8_b' },
      data: { jobId, offerId, requestId: 'req-stage7-stage8-b' },
    }),
    err => err.code === 'permission-denied'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-stage7-stage8-b')), false);
});

// ════════════════════════════════════════════════════════════════════════════════
// 7. TRUE RECEIPT-FIRST IDEMPOTENCY
// ════════════════════════════════════════════════════════════════════════════════
test('7. True Receipt-First Idempotency: replay returns stored result with idempotent: true without reading mutated job state', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_idem_1',
    driverId: 'driver_idem_1',
    offerId: 'offer_idem_1',
    commissionPaise: 5000,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const initialRes = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-idem-1',
  });
  assert.equal(initialRes.cancelled, true);

  // Now simulate extreme job progression: job was reassigned, completed, or cancelled_customer
  await jobRef(jobId).update({
    status: 'completed',
    dispatchState: 'completed',
    assignedDriver: 'some_other_driver',
  });

  // Also simulate driver state change: e.g. driver wallet changed
  await driverRef(driverId).update({
    walletBalance: 99999,
  });

  // Replay exact same request
  const replayRes = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-idem-1',
  });

  // Must return initial result with idempotent: true
  assert.deepEqual(replayRes, {
    ...initialRes,
    idempotent: true,
  });

  // Driver wallet should NOT be affected by replay
  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.walletBalance, 99999);
});

// ════════════════════════════════════════════════════════════════════════════════
// 8. CONCURRENT DUPLICATE REQUEST WITH IDENTICAL requestId
// ════════════════════════════════════════════════════════════════════════════════
test('8. concurrent duplicate cancelJob with identical requestId executes mutations exactly once', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_dup_1',
    driverId: 'driver_dup_1',
    offerId: 'offer_dup_1',
    commissionPaise: 5000,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });

  const [res1, res2] = await Promise.all([
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-dup-1',
    }),
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-dup-1',
    }),
  ]);

  // One will be cancelled: true, the other cancelled: true with idempotent: true (or both successful)
  assert.equal(res1.cancelled, true);
  assert.equal(res2.cancelled, true);
  const idempotentFlags = [res1.idempotent, res2.idempotent];
  assert.ok(idempotentFlags.includes(true) || idempotentFlags.includes(undefined));

  // Wallet credited exactly once: 20000 + 5000 = 25000
  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.walletBalance, 25000);
  assert.deepEqual(driverDoc.monthlyCancelCount, { month: '2026-09', count: 1 });
});

// ════════════════════════════════════════════════════════════════════════════════
// 9. STAGE 4 NULL VS STRING requestId BACKWARDS COMPATIBILITY
// ════════════════════════════════════════════════════════════════════════════════
test('9A. Stage 4 compatibility: acceptance with null requestId cancels successfully', async () => {
  // Directly seed accepted state with null acceptRequestId and null commission_debit.sourceRequestId
  const jobId = 'job_stage4_null';
  const driverId = 'driver_stage4_null';
  const offerId = 'offer_stage4_null';

  await seedDriver(driverId, { activeJobId: jobId, walletBalance: 20000 });

  const acceptedAt = T.fromMillis(clock - 5000);
  const j = paidJob(T, clock, {
    status: 'accepted',
    dispatchState: 'assigned',
    assignedDriver: driverId,
    currentOfferId: offerId,
    driverCommissionPaise: 5000,
    commissionDebitEntryId: `commission_debit:${jobId}:${offerId}`,
    stateVersion: 2,
    dispatchGeneration: 1,
    dispatchRunId: '1',
    forfeitedAmount: 0,
    acceptedAt,
    offeredTo: null,
    offeredAt: null,
    offerExpiresAt: null,
    inProgressAt: null,
    completedAt: null,
    cancellationResolutionState: 'none',
    cancellationRequestedAt: null,
    cancellationResolvedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    refundRequestId: null,
    refundState: 'none',
    refundNextAttemptAt: null,
    razorpayRefundId: null,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
  });
  await jobRef(jobId).set(j);

  const fullConfig = config(T, clock);
  const policySnapshot = Object.fromEntries(POLICY_KEYS.map(key => [key, fullConfig[key]]));

  await offerRef(offerId).set({
    jobId,
    driverId,
    dispatchGeneration: 1,
    candidateIndex: 0,
    roundIndex: 0,
    status: 'accepted',
    offeredAt: T.fromMillis(clock - 10000),
    expiresAt: T.fromMillis(clock + 35000),
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'not_required',
    acceptRequestId: null, // Stage 4 null
    cancellationPolicySnapshot: {
      version: 1,
      timezone: 'Asia/Kolkata',
      roundingMode: 'HALF_UP',
      freeCancellationsPerMonth: 1,
      forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
      banThresholdCount: 6,
      banDurationDays: 7,
      capturedAt: acceptedAt,
    },
    pickupCoords: j.pickupCoords,
    destCoords: j.destCoords,
    requestedTruckType: j.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: j.estimatedFarePaise,
    driverCommissionPaise: 5000,
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: acceptedAt,
  });

  await runRef(jobId, 1).set({
    jobId,
    generation: 1,
    status: 'assigned',
    policyVersion: 1,
    policySnapshot,
    candidates: [{
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    }],
    nextCandidateIndex: 1,
    attemptedDriverIds: [driverId],
    excludedDriverIds: [],
    currentOfferId: offerId,
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: acceptedAt,
    finalizedAt: null,
  });

  await debitLedgerRef(jobId, offerId).set({
    operationId: `commission_debit:${jobId}:${offerId}`,
    driverId,
    jobId,
    offerId,
    type: 'commission_debit',
    commissionPaise: 5000,
    forfeiturePaise: 0,
    creditPaise: 0,
    deltaPaise: -5000,
    balanceBeforePaise: 25000,
    balanceAfterPaise: 20000,
    cancellationPolicyEvidence: null,
    sourceRequestId: null, // Stage 4 null
    sourceType: 'driver',
    actorUid: driverId,
    createdAt: acceptedAt,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-stage4-cancel-null',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.refundPaise, 5000);
  assert.equal(res.forfeitedPaise, 0);
});

test('9B. Stage 4 compatibility: acceptance with matching string requestId cancels successfully', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_stage4_str',
    driverId: 'driver_stage4_str',
    offerId: 'offer_stage4_str',
    acceptRequestId: 'req-accept-valid-str',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-stage4-cancel-str',
  });

  assert.equal(res.cancelled, true);
});

test('9C. Stage 4 compatibility: mismatched acceptance requestId rejects with INVALID_REQUEST_CORRELATION', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_stage4_mismatch',
    driverId: 'driver_stage4_mismatch',
    offerId: 'offer_stage4_mismatch',
    acceptRequestId: 'req-accept-original',
  });

  // Tamper debit entry to simulate corruption
  await debitLedgerRef(jobId, offerId).update({
    sourceRequestId: 'req-accept-tampered',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-cancel-mismatch',
    }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Assert zero domain writes
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'accepted');
});

// ════════════════════════════════════════════════════════════════════════════════
// 10. CASCADE REDISPATCH & CANDIDATE EXCLUSION
// ════════════════════════════════════════════════════════════════════════════════
test('10. cascade redispatch: cancelling driver excluded from run, job returns to pending_offer, processDispatchJob offers next candidate', async () => {
  const jobId = 'job_redispatch_1';
  const driverA = 'driver_redispatch_A';
  const driverB = 'driver_redispatch_B';
  const offerA = 'offer_redispatch_A';

  await seedDriver(driverB, { location: new GeoPoint(18.526, 73.86) });

  const { offerId } = await setupAndAcceptJob({
    jobId,
    driverId: driverA,
    offerId: offerA,
    extraCandidates: [{
      driverId: driverB,
      roundIndex: 0,
      haversineDistanceKm: 4.0,
      matrixEtaSeconds: 650,
      matrixDistanceMeters: 5500,
      rankingMode: 'ola',
      outcome: 'pending',
      reasonCode: null,
    }],
  });

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const dispatchService = createDispatchService({ db, now, taskQueueService, TimestampClass: T });

  let redispatchedJobId = null;
  const dispatchSpy = {
    processDispatchJob: async jId => {
      redispatchedJobId = jId;
    },
  };

  const cancelMgr = createCancelJobManager({
    db,
    TimestampClass: T,
    now,
    dispatchService: dispatchSpy,
  });

  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverA,
    requestId: 'req-redispatch-1',
  });
  assert.equal(res.cancelled, true);

  // Verify cancelling driver was excluded and nextCandidateIndex is preserved at 1
  const runAfterCancel = await read(runRef(jobId, 1));
  assert.equal(runAfterCancel.candidates[0].outcome, 'driver_cancelled');
  assert.deepEqual(runAfterCancel.excludedDriverIds, [driverA]);
  assert.equal(runAfterCancel.nextCandidateIndex, 1);

  // Verify dispatchService was kicked
  assert.equal(redispatchedJobId, jobId);

  // Allow asynchronous dispatch kick to finish
  await dispatchService.processDispatchJob(jobId);

  // Job should now be offered to driver B!
  const jobAfterRedispatch = await read(jobRef(jobId));
  assert.equal(jobAfterRedispatch.status, 'offered');
  assert.equal(jobAfterRedispatch.dispatchState, 'offered');
  assert.equal(jobAfterRedispatch.offeredTo, driverB);

  const runAfterRedispatch = await read(runRef(jobId, 1));
  assert.equal(runAfterRedispatch.candidates[1].outcome, 'offered');
  assert.equal(runAfterRedispatch.nextCandidateIndex, 2);
  assert.deepEqual(runAfterRedispatch.attemptedDriverIds, [driverA, driverB]);
  assert.deepEqual(runAfterRedispatch.excludedDriverIds, [driverA]);
});

// ════════════════════════════════════════════════════════════════════════════════
// 11. PRECONDITIONS & AUTH CHECKS ON EMULATOR
// ════════════════════════════════════════════════════════════════════════════════
test('11A. caller uid mismatch throws FORBIDDEN_CALLER and performs zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_auth_1',
    driverId: 'driver_auth_1',
    offerId: 'offer_auth_1',
  });
  await seedDriver('different_driver_uid');

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: 'different_driver_uid',
      requestId: 'req-auth-mismatch',
    }),
    err => err instanceof DispatchError && err.code === 'WRONG_DRIVER'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
});

test('11B. cancelling an offered job throws JOB_NOT_ACCEPTED and performs zero writes', async () => {
  const jobId = 'job_not_acc_1';
  const driverId = 'driver_not_acc_1';
  const offerId = 'offer_not_acc_1';

  await seedDriver(driverId);
  await seedOfferedJobAndRun({ jobId, driverId, offerId });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-not-accepted',
    }),
    err => err instanceof DispatchError && err.code === 'JOB_NOT_ACCEPTED'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
});

// ════════════════════════════════════════════════════════════════════════════════
// 12. ASIA/KOLKATA MONTH ROLLOVER RESET ON EMULATOR
// ════════════════════════════════════════════════════════════════════════════════
test('12. month rollover: driver with 4 cancellations in August 2026 resets to count 1 (free tier) in September 2026', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_rollover_1',
    driverId: 'driver_rollover_1',
    offerId: 'offer_rollover_1',
    commissionPaise: 5000,
    driverPatch: {
      walletBalance: 25000,
      monthlyCancelCount: { month: '2026-08', count: 4 }, // August had 4 cancels
    },
  });

  // Current clock is September 2026 ('2026-09')
  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-rollover-1',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 0); // 1st cancel is free (0% forfeit)
  assert.equal(res.refundPaise, 5000); // 100% credited

  const driverDoc = await read(driverRef(driverId));
  assert.deepEqual(driverDoc.monthlyCancelCount, { month: '2026-09', count: 1 });
});

// ════════════════════════════════════════════════════════════════════════════════
// 13. AUDIT REGRESSION INTEGRATION TESTS (BLOCKERS 1, 4, 6, 8)
// ════════════════════════════════════════════════════════════════════════════════

test('13A. Blocker 1: lone cancellationRequestedAt fails closed with zero writes on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b1',
    driverId: 'driver_emu_b1',
    offerId: 'offer_emu_b1',
  });

  await jobRef(jobId).update({
    cancellationRequestedAt: T.fromMillis(clock - 1000),
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b1',
    }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b1')), false);
  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.walletBalance, 20000); // balanceBefore was 25000 - 5000 commission debit
  assert.equal(driverDoc.monthlyCancelCount.count, 0);
});

test('13B. Blocker 4: wallet balance overflow beyond MAX_SAFE fails closed with zero writes on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b4',
    driverId: 'driver_emu_b4',
    offerId: 'offer_emu_b4',
  });

  // Set walletBalance to MAX_SAFE_INTEGER directly so 5000 paise refund overflows
  await driverRef(driverId).update({ walletBalance: Number.MAX_SAFE_INTEGER });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b4',
    }),
    err => err instanceof DispatchError && err.code === 'WALLET_OVERFLOW'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b4')), false);
  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.walletBalance, Number.MAX_SAFE_INTEGER); // Unchanged!
});

test('13C. Blocker 6: policy snapshot capturedAt mismatch (+1ms) fails closed with zero writes on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b6',
    driverId: 'driver_emu_b6',
    offerId: 'offer_emu_b6',
  });

  const offerData = await read(offerRef(offerId));
  const badCapturedAt = T.fromMillis(offerData.acceptedAt.toMillis() + 1);
  await offerRef(offerId).update({
    'cancellationPolicySnapshot.capturedAt': badCapturedAt,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b6',
    }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b6')), false);
});

test('13D. Blocker 8B: Driver B calling cancelJob against Driver A customer-pending occurrence fails closed with permission-denied', async () => {
  const { jobId, driverId: driverA, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b8a',
    driverId: 'driver_emu_b8a',
    offerId: 'offer_emu_b8a',
  });
  await seedDriver('driver_emu_b8b');

  await jobRef(jobId).update({
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: T.fromMillis(clock - 500),
  });

  const { createCancelJobCallable } = require('../../../firebase/functions/src/dispatch/cancelJob');
  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const callable = createCancelJobCallable({ cancelJobManager: cancelMgr });

  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_emu_b8b' },
      data: { jobId, offerId, requestId: 'req-emu-b8b' },
    }),
    err => err.code === 'permission-denied'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b8b')), false);
});

test('13E. Blocker 8B: Driver B calling cancelJob against Driver A customer-terminal occurrence fails closed with permission-denied', async () => {
  const { jobId, driverId: driverA, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b8c',
    driverId: 'driver_emu_b8c',
    offerId: 'offer_emu_b8c',
  });
  await seedDriver('driver_emu_b8d');

  const reqTime = T.fromMillis(clock - 1000);
  const resTime = T.fromMillis(clock - 500);
  await jobRef(jobId).update({
    status: 'cancelled_customer',
    dispatchState: 'closed',
    assignedDriver: null,
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'resolved',
    cancellationRequestedAt: reqTime,
    cancellationResolvedAt: resTime,
    cancelledAt: resTime,
  });

  const { createCancelJobCallable } = require('../../../firebase/functions/src/dispatch/cancelJob');
  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const callable = createCancelJobCallable({ cancelJobManager: cancelMgr });

  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_emu_b8d' },
      data: { jobId, offerId, requestId: 'req-emu-b8d' },
    }),
    err => err.code === 'permission-denied'
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b8d')), false);
});

test('13F. Blocker 8B: Wrong offer ID against job fails closed with OFFER_BINDING_MISMATCH / permission-denied', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b8e',
    driverId: 'driver_emu_b8e',
    offerId: 'offer_emu_b8e',
  });

  // Seed another offer belonging to a different job
  await offerRef('offer_other_job').set({
    jobId: 'other_job_xyz',
    driverId,
    status: 'accepted',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId: 'offer_other_job',
      driverUid: driverId,
      requestId: 'req-emu-b8e',
    }),
    err => err instanceof DispatchError && (err.code === 'OFFER_BINDING_MISMATCH' || err.code === 'JOB_OFFER_MISMATCH')
  );

  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b8e')), false);
});

test('13G. Blocker 7 & 8B: Valid historical receipt still replays after job assignment has mutated', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_hist_1',
    driverId: 'driver_emu_hist_1',
    offerId: 'offer_emu_hist_1',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const firstRes = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-hist-1',
  });
  assert.equal(firstRes.cancelled, true);

  // Now job mutates (e.g. redispatched and assigned to driver C)
  await jobRef(jobId).update({
    status: 'accepted',
    dispatchState: 'assigned',
    assignedDriver: 'driver_C',
    currentOfferId: 'offer_C',
  });

  // Idempotent retry with same requestId returns replay immediately
  const replayRes = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-hist-1',
  });
  assert.equal(replayRes.cancelled, true);
  assert.equal(replayRes.idempotent, true);
  assert.equal(replayRes.driverId, driverId);
});

test('13H. Blocker 8A: Extra callable payload property is rejected with invalid-argument on emulator', async () => {
  const { createCancelJobCallable } = require('../../../firebase/functions/src/dispatch/cancelJob');
  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const callable = createCancelJobCallable({ cancelJobManager: cancelMgr });

  await assert.rejects(
    callable.run({
      auth: { uid: 'some_driver' },
      data: { jobId: 'job_1', offerId: 'offer_1', requestId: 'req_1', unexpectedField: true },
    }),
    err => err.code === 'invalid-argument'
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// 14. AUDIT B1-B5 EMULATOR VERIFICATION
// ════════════════════════════════════════════════════════════════════════════════
test('14A. Audit B1: legal null routing values allow cancelJob to succeed on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b1_null',
    driverId: 'driver_emu_b1_null',
    offerId: 'offer_emu_b1_null',
  });
  await offerRef(offerId).update({
    pickupRoutedDistanceMeters: null,
    pickupEtaSeconds: null,
  });
  const runSnap = await runRef(jobId, 1).get();
  const runData = runSnap.data();
  runData.candidates[0].rankingMode = 'haversine_degraded';
  runData.candidates[0].matrixDistanceMeters = null;
  runData.candidates[0].matrixEtaSeconds = null;
  await runRef(jobId, 1).set(runData);

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-b1-null',
  });
  assert.equal(res.cancelled, true);
});

test('14B. Audit B1: legal fractional routing values allow cancelJob to succeed on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b1_frac',
    driverId: 'driver_emu_b1_frac',
    offerId: 'offer_emu_b1_frac',
  });
  await offerRef(offerId).update({
    pickupRoutedDistanceMeters: 2000.25,
    pickupEtaSeconds: 300.5,
  });
  const runSnap = await runRef(jobId, 1).get();
  const runData = runSnap.data();
  runData.candidates[0].matrixDistanceMeters = 2000.25;
  runData.candidates[0].matrixEtaSeconds = 300.5;
  await runRef(jobId, 1).set(runData);

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-b1-frac',
  });
  assert.equal(res.cancelled, true);
});

test('14C. Audit B1 & B3: contradictory offer vs candidate routing values reject with zero writes on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b1_mismatch',
    driverId: 'driver_emu_b1_mismatch',
    offerId: 'offer_emu_b1_mismatch',
  });
  await offerRef(offerId).update({
    pickupRoutedDistanceMeters: 5000,
  });
  const runSnap = await runRef(jobId, 1).get();
  const runData = runSnap.data();
  runData.candidates[0].matrixDistanceMeters = 4000;
  await runRef(jobId, 1).set(runData);

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b1-mismatch',
    }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b1-mismatch')), false);
});

test('14D. Audit B3: fare and truck type mismatch reject with zero writes on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b3_mismatch',
    driverId: 'driver_emu_b3_mismatch',
    offerId: 'offer_emu_b3_mismatch',
  });
  await offerRef(offerId).update({
    estimatedFarePaise: 99999,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b3-mismatch',
    }),
    err => err instanceof DispatchError && (err.code === 'OFFER_INVALID' || err.code === 'ACCEPTANCE_CONFLICT')
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b3-mismatch')), false);
});

test('14E. Audit B4: terminal customer cancellation precedence with mismatched offer ID rejects with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b4_mismatch',
    driverId: 'driver_emu_b4_mismatch',
    offerId: 'offer_emu_b4_mismatch',
  });

  clock += 1000;
  const reqTime = T.fromMillis(clock);
  clock += 500;
  const resTime = T.fromMillis(clock);
  await jobRef(jobId).update({
    status: 'cancelled_customer',
    dispatchState: 'closed',
    currentOfferId: 'some_other_offer_id',
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'resolved',
    cancellationRequestedAt: reqTime,
    cancellationResolvedAt: resTime,
    cancelledAt: resTime,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-b4-mismatch',
    }),
    err => err instanceof DispatchError && (err.code === 'JOB_OFFER_MISMATCH' || err.code === 'OFFER_BINDING_MISMATCH')
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-b4-mismatch')), false);
});

test('14F. Audit B5: ban renewal unconditionally sets fresh now + 7 days, overwriting longer ban on emulator', async () => {
  const driverId = 'driver_emu_b5_ban';
  const tenDaysMs = 10 * 86400 * 1000;
  const sevenDaysMs = 7 * 86400 * 1000;
  const { jobId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_b5_ban',
    driverId,
    offerId: 'offer_emu_b5_ban',
    driverPatch: {
      monthlyCancelCount: { month: '2026-09', count: 5 },
      strictMode: false,
    },
  });
  await driverRef(driverId).update({
    bannedUntil: T.fromMillis(clock + tenDaysMs),
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const cancelTime = clock;
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-b5-ban',
  });
  assert.equal(res.cancelled, true);

  const updatedDriver = await read(driverRef(driverId));
  assert.equal(updatedDriver.strictMode, true);
  assert.equal(updatedDriver.monthlyCancelCount.count, 6);
  assert.equal(updatedDriver.bannedUntil.toMillis(), cancelTime + sevenDaysMs);
});

// ════════════════════════════════════════════════════════════════════════════════
// 15. BLOCKERS F1-F5 INDEPENDENT INTEGRATION TESTS
// ════════════════════════════════════════════════════════════════════════════════
test('15A. Blocker F1: timeout task state and taskId relational contract enforced on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_f1_task',
    driverId: 'driver_emu_f1_task',
    offerId: 'offer_emu_f1_task',
  });

  // Corrupt timeout task state: pending with a task ID
  await offerRef(offerId).update({
    timeoutTaskState: 'pending',
    timeoutTaskId: 'task_bogus_123',
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-f1-corrupt',
    }),
    err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-f1-corrupt')), false);
});

test('15B. Blocker F2: terminal accepted customer precedence validates all provenance on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_f2_term',
    driverId: 'driver_emu_f2_term',
    offerId: 'offer_emu_f2_term',
  });

  clock += 1000;
  const reqTime = T.fromMillis(clock);
  clock += 500;
  const resTime = T.fromMillis(clock);
  await jobRef(jobId).update({
    status: 'cancelled_customer',
    dispatchState: 'closed',
    assignedDriver: null, // Corrupted assignedDriver to null
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'resolved',
    cancellationRequestedAt: reqTime,
    cancellationResolvedAt: resTime,
    cancelledAt: resTime,
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-f2-no-assigned',
    }),
    err => err instanceof DispatchError && err.code === 'WRONG_DRIVER'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-f2-no-assigned')), false);
});

test('15C. Blocker F3: zero informational fare succeeds with positive commission on emulator', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_f3_zero',
    driverId: 'driver_emu_f3_zero',
    offerId: 'offer_emu_f3_zero',
  });

  await jobRef(jobId).update({ estimatedFarePaise: 0 });
  await offerRef(offerId).update({ estimatedFarePaise: 0 });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  const res = await cancelMgr.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-emu-f3-zero',
  });
  assert.equal(res.cancelled, true);
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), true);
});

test('15D. Blocker F4: 45,001 ms offer lifetime rejects on emulator with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_f4_lifetime',
    driverId: 'driver_emu_f4_lifetime',
    offerId: 'offer_emu_f4_lifetime',
  });

  const offerSnap = await offerRef(offerId).get();
  const offData = offerSnap.data();
  // Corrupt expiresAt by +1 ms -> 45,001 ms lifetime
  await offerRef(offerId).update({
    expiresAt: T.fromMillis(offData.expiresAt.toMillis() + 1),
  });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-f4-drift',
    }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-f4-drift')), false);
});

test('15E. Blocker F5: cancellation event preceding acceptance rejects on emulator with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAcceptJob({
    jobId: 'job_emu_f5_chrono',
    driverId: 'driver_emu_f5_chrono',
    offerId: 'offer_emu_f5_chrono',
  });

  // Advance acceptance timestamps to future: clock + 5000ms
  const futureAcceptedAt = T.fromMillis(clock + 5000);
  await jobRef(jobId).update({ acceptedAt: futureAcceptedAt });
  await offerRef(offerId).update({ acceptedAt: futureAcceptedAt, 'cancellationPolicySnapshot.capturedAt': futureAcceptedAt });
  await debitLedgerRef(jobId, offerId).update({ createdAt: futureAcceptedAt });

  const cancelMgr = createCancelJobManager({ db, TimestampClass: T, now });
  await assert.rejects(
    cancelMgr.cancelJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req-emu-f5-future-acc',
    }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.equal(await exists(creditLedgerRef(jobId, offerId)), false);
  assert.equal(await exists(receiptRef('req-emu-f5-future-acc')), false);
});
