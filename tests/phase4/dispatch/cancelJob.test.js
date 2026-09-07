'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { GeoPoint } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createCancelJobManager,
  createCancelJobCallable,
} = require('../../../firebase/functions/src/dispatch/cancelJob');
const {
  DispatchError,
  exactKeys,
  getIstMonthString,
  WALLET_EXACT_KEYS,
  CANCELLATION_EVIDENCE_EXACT_KEYS,
  calculateForfeitureHalfUp,
} = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { taskIdForOfferTimeout } = require('../../../firebase/functions/src/services/taskQueueService');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const { paidJob, driver } = require('../fixtures');

function cloneDb(data) {
  if (data === undefined || data === null) return data;
  if (data instanceof FakeTimestamp) return new FakeTimestamp(data.seconds, data.nanoseconds);
  if (data instanceof GeoPoint) return new GeoPoint(data.latitude, data.longitude);
  if (data instanceof Date) return new Date(data.getTime());
  if (Array.isArray(data)) return data.map(cloneDb);
  if (typeof data === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(data)) copy[k] = cloneDb(v);
    return copy;
  }
  return data;
}

function captureFullDbSnapshot(db) {
  return cloneDb(db.data);
}

function setupAcceptedSeed({
  nowMs = 1757184000000,
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
  ledgerPatch = {},
  acceptRequestId = 'req-accept-1',
} = {}) {
  const jobId = 'job_test_1';
  const driverId = 'driver_test_1';
  const generation = 1;
  const offerId = 'offer_test_1';
  const acceptedAt = FakeTimestamp.fromMillis(nowMs - 20000);

  const job = paidJob(FakeTimestamp, nowMs, {
    status: 'accepted',
    dispatchState: 'assigned',
    assignedDriver: driverId,
    currentOfferId: offerId,
    offeredTo: null,
    offeredAt: null,
    offerExpiresAt: null,
    acceptedAt,
    inProgressAt: null,
    completedAt: null,
    dispatchGeneration: generation,
    dispatchRunId: String(generation),
    stateVersion: 1,
    driverCommissionPaise: 5000,
    commissionDebitEntryId: 'commission_debit:' + jobId + ':' + offerId,
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
    forfeitedAmount: null,
    ...jobPatch,
  });

  const driverDoc = driver(FakeTimestamp, nowMs, {
    activeOfferId: null,
    activeJobId: jobId,
    walletBalance: 20000,
    verificationStatus: 'approved',
    isOnDuty: true,
    canFlatbed: true,
    canPulling: false,
    bannedUntil: null,
    strictMode: false,
    monthlyCancelCount: {
      month: getIstMonthString(nowMs),
      count: 0,
    },
    ...driverPatch,
  });

  const policySnapshot = {
    version: 1,
    timezone: 'Asia/Kolkata',
    roundingMode: 'HALF_UP',
    freeCancellationsPerMonth: 1,
    forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
    banThresholdCount: 6,
    banDurationDays: 7,
    capturedAt: acceptedAt,
  };

  const offer = {
    jobId,
    driverId,
    dispatchGeneration: generation,
    candidateIndex: 0,
    roundIndex: 0,
    status: 'accepted',
    offeredAt: FakeTimestamp.fromMillis(nowMs - 30000),
    expiresAt: FakeTimestamp.fromMillis(nowMs + 15000),
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'not_required',
    acceptRequestId,
    cancellationPolicySnapshot: policySnapshot,
    pickupCoords: job.pickupCoords,
    destCoords: job.destCoords,
    requestedTruckType: job.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: job.estimatedFarePaise,
    driverCommissionPaise: 5000,
    createdAt: FakeTimestamp.fromMillis(nowMs - 30000),
    updatedAt: acceptedAt,
    ...offerPatch,
  };

  const run = {
    jobId,
    generation,
    policyVersion: 1,
    status: 'assigned',
    policySnapshot: {
      locationFreshnessSeconds: 120,
      radiusKmSequence: [10, 20, 35],
      maxUniqueCandidatesPerGeneration: 30,
      maxMatrixShortlistPerRound: 10,
      rankingPrimary: 'ola_eta_seconds',
      rankingSecondary: 'ola_distance_meters',
      rankingTieBreak: 'driver_uid',
      olaFailureMode: 'bounded_retry_then_haversine_degraded',
    },
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
    currentOfferId: offerId,
    attemptedDriverIds: [driverId],
    excludedDriverIds: [],
    finalizedAt: null,
    createdAt: FakeTimestamp.fromMillis(nowMs - 30000),
    updatedAt: acceptedAt,
    ...runPatch,
  };

  const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
  const ledger = {
    operationId: ledgerId,
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
    sourceRequestId: acceptRequestId,
    sourceType: 'driver',
    actorUid: driverId,
    createdAt: acceptedAt,
    ...ledgerPatch,
  };

  const db = new FakeFirestore();
  db.data.jobs = { [jobId]: job };
  db.data.job_offers = { [offerId]: offer };
  db.data.drivers = { [driverId]: driverDoc };
  db.data['jobs/' + jobId + '/dispatch_runs'] = { [String(generation)]: run };
  db.data.wallet_entries = { [ledgerId]: ledger };
  db.data.processed_requests = {};

  return {
    db,
    jobId,
    offerId,
    driverId,
    generation,
    policySnapshot,
    nowMs,
    acceptedAt,
  };
}

// ── Ramp Tests ─────────────────────────────────────────────────────────────

test('1. Count 1 (free cancellation): 0% forfeiture, 100% refund, count becomes 1', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 0 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-1',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 0);
  assert.equal(res.refundPaise, 5000);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.walletBalance, 25000);
  assert.equal(driverDoc.monthlyCancelCount.count, 1);
  assert.equal(driverDoc.strictMode, false);
  assert.equal(driverDoc.bannedUntil, null);

  const jobDoc = db.data.jobs[jobId];
  assert.equal(jobDoc.status, 'pending_offer');
  assert.equal(jobDoc.dispatchState, 'ready');
  assert.equal(jobDoc.assignedDriver, null);
  assert.equal(jobDoc.forfeitedAmount, 0);
  assert.equal(jobDoc.stateVersion, 2);

  const creditDoc = db.data.wallet_entries['driver_cancel_credit:' + jobId + ':' + offerId];
  assert.ok(creditDoc);
  assert.equal(creditDoc.forfeiturePaise, 0);
  assert.equal(creditDoc.creditPaise, 5000);
  assert.equal(creditDoc.deltaPaise, 5000);
  assert.equal(creditDoc.balanceBeforePaise, 20000);
  assert.equal(creditDoc.balanceAfterPaise, 25000);
  assert.equal(creditDoc.cancellationPolicyEvidence.cancellationCount, 1);
  assert.equal(creditDoc.cancellationPolicyEvidence.forfeiturePercent, 0);
  assert.equal(creditDoc.cancellationPolicyEvidence.strictModeApplied, false);
});

test('2. Count 2: 20% forfeiture, 80% refund (1000 paise forfeit, 4000 paise refund)', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 1 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-2',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 1000);
  assert.equal(res.refundPaise, 4000);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.walletBalance, 24000);
  assert.equal(driverDoc.monthlyCancelCount.count, 2);
  assert.equal(driverDoc.strictMode, false);
  assert.equal(driverDoc.bannedUntil, null);

  const jobDoc = db.data.jobs[jobId];
  assert.equal(jobDoc.forfeitedAmount, 1000);
});

test('3. Count 3: 30% forfeiture, 70% refund (1500 paise forfeit, 3500 paise refund)', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 2 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-3',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 1500);
  assert.equal(res.refundPaise, 3500);
  assert.equal(db.data.drivers[driverId].walletBalance, 23500);
  assert.equal(db.data.drivers[driverId].monthlyCancelCount.count, 3);
});

test('4. Count 4: 40% forfeiture, 60% refund (2000 paise forfeit, 3000 paise refund)', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 3 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-4',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 2000);
  assert.equal(res.refundPaise, 3000);
  assert.equal(db.data.drivers[driverId].walletBalance, 23000);
  assert.equal(db.data.drivers[driverId].monthlyCancelCount.count, 4);
});

test('5. Count 5: 50% forfeiture, 50% refund (2500 paise forfeit, 2500 paise refund)', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 4 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-5',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 2500);
  assert.equal(res.refundPaise, 2500);
  assert.equal(db.data.drivers[driverId].walletBalance, 22500);
  assert.equal(db.data.drivers[driverId].monthlyCancelCount.count, 5);
  assert.equal(db.data.drivers[driverId].strictMode, false);
  assert.equal(db.data.drivers[driverId].bannedUntil, null);
});

test('6. Count 6 (Ban threshold reached): 100% forfeiture, 0 refund, flat 7-day ban, strictMode=true', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 5 },
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-6',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 5000);
  assert.equal(res.refundPaise, 0);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.walletBalance, 20000);
  assert.equal(driverDoc.monthlyCancelCount.count, 6);
  assert.equal(driverDoc.strictMode, true);
  assert.ok(driverDoc.bannedUntil);
  const expectedBanMs = nowMs + 7 * 86400000;
  assert.equal(driverDoc.bannedUntil.toMillis(), expectedBanMs);

  const creditDoc = db.data.wallet_entries['driver_cancel_credit:' + jobId + ':' + offerId];
  assert.equal(creditDoc.forfeiturePaise, 5000);
  assert.equal(creditDoc.creditPaise, 0);
  assert.equal(creditDoc.deltaPaise, 0);
  assert.equal(creditDoc.balanceBeforePaise, 20000);
  assert.equal(creditDoc.balanceAfterPaise, 20000);
  assert.equal(creditDoc.cancellationPolicyEvidence.cancellationCount, 6);
  assert.equal(creditDoc.cancellationPolicyEvidence.forfeiturePercent, 100);
  assert.equal(creditDoc.cancellationPolicyEvidence.strictModeApplied, true);
});

test('7. Subsequent cancellation under strictMode: 100% forfeiture and resets flat 7-day ban', async () => {
  const nowMs = 1757184000000;
  const existingBanMs = nowMs + 3 * 86400000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 6 },
      strictMode: true,
      bannedUntil: FakeTimestamp.fromMillis(existingBanMs),
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-7',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 5000);
  assert.equal(res.refundPaise, 0);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.monthlyCancelCount.count, 7);
  assert.equal(driverDoc.strictMode, true);
  const expectedNewBanMs = nowMs + 7 * 86400000;
  assert.equal(driverDoc.bannedUntil.toMillis(), expectedNewBanMs);
});

test('8. Half-up integer rounding on odd paise: commission 1255 paise at 30% forfeit -> 377 forfeit, 878 credit', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    jobPatch: { driverCommissionPaise: 1255 },
    offerPatch: { driverCommissionPaise: 1255 },
    ledgerPatch: { commissionPaise: 1255, deltaPaise: -1255, balanceAfterPaise: 25000 - 1255 },
    driverPatch: {
      monthlyCancelCount: { month: getIstMonthString(nowMs), count: 2 },
      walletBalance: 25000 - 1255,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-odd',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 377);
  assert.equal(res.refundPaise, 878);
  assert.equal(res.forfeitedPaise + res.refundPaise, 1255);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.walletBalance, (25000 - 1255) + 878);

  const creditDoc = db.data.wallet_entries['driver_cancel_credit:' + jobId + ':' + offerId];
  assert.equal(creditDoc.forfeiturePaise, 377);
  assert.equal(creditDoc.creditPaise, 878);
  assert.equal(creditDoc.deltaPaise, 878);
  assert.equal(creditDoc.balanceAfterPaise, creditDoc.balanceBeforePaise + 878);
});

test('9. Asia/Kolkata month rollover: March -> April resets count to 0, strictMode to false, evaluated cancellation is count 1 (free), preserves unexpired ban', async () => {
  const aprilDateMs = new Date('2026-03-31T19:00:00.000Z').getTime();
  const banRemainingMs = aprilDateMs + 2 * 86400000;

  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs: aprilDateMs,
    driverPatch: {
      monthlyCancelCount: { month: '2026-03', count: 6 },
      strictMode: true,
      bannedUntil: FakeTimestamp.fromMillis(banRemainingMs),
      walletBalance: 20000,
    },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(aprilDateMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-apr',
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 0);
  assert.equal(res.refundPaise, 5000);

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.monthlyCancelCount.month, '2026-04');
  assert.equal(driverDoc.monthlyCancelCount.count, 1);
  assert.equal(driverDoc.strictMode, false);
  assert.equal(driverDoc.bannedUntil.toMillis(), banRemainingMs);
});

// ── True Receipt-First Transaction Read (Lock 3) ──────────────────────────

test('10. Lock 3: True receipt-first transaction read returns stored result with idempotent:true without reading mutable job/run/driver state', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-replay-1';
  const at = FakeTimestamp.fromMillis(nowMs - 5000);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests[requestId] = {
    requestId,
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: {
      cancelled: true,
      driverId,
      forfeitedPaise: 1000,
      jobId,
      offerId,
      refundPaise: 4000,
    },
  };

  delete db.data.jobs[jobId];

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId,
  });

  assert.equal(res.cancelled, true);
  assert.equal(res.idempotent, true);
  assert.equal(res.forfeitedPaise, 1000);
  assert.equal(res.refundPaise, 4000);
  assert.equal(res.jobId, jobId);
  assert.equal(res.offerId, offerId);
  assert.equal(res.driverId, driverId);

  assert.deepEqual(db.data, beforeDb);
});

test('11. In-progress receipt rejects with REQUEST_IN_PROGRESS and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-prog-1';
  db.data.processed_requests[requestId] = {
    requestId,
    status: 'in_progress',
    type: 'phase4_client_mutation',
    ownerToken: 'token123',
    claimedAt: FakeTimestamp.fromMillis(nowMs - 1000),
    leaseUntil: FakeTimestamp.fromMillis(nowMs + 30000),
    processedAt: null,
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash: 'hash',
    result: null,
  };

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err instanceof DispatchError && err.code === 'REQUEST_IN_PROGRESS'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('12. Reused requestId with altered payloadHash fails closed with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-tamper-1';
  const at = FakeTimestamp.fromMillis(nowMs - 5000);
  db.data.processed_requests[requestId] = {
    requestId,
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash: 'different_payload_hash',
    result: {
      cancelled: true,
      driverId,
      forfeitedPaise: 0,
      jobId,
      offerId,
      refundPaise: 5000,
    },
  };

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err instanceof DispatchError && err.code === 'REQUEST_BINDING_CONFLICT'
  );

  assert.deepEqual(db.data, beforeDb);
});

// ── Lock 1: Stage 4 null vs string requestId Compatibility ──────────────────

test('13. Lock 1 Case A: acceptance with valid string requestId succeeds', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    acceptRequestId: 'stage4_valid_req_123',
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-str',
  });

  assert.equal(res.cancelled, true);
});

test('14. Lock 1 Case B: historical acceptance without requestId (both null) succeeds', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    acceptRequestId: null,
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-cancel-null',
  });

  assert.equal(res.cancelled, true);
});

test('15. Lock 1 Rejection: offer.acceptRequestId string but debit.sourceRequestId null fails with LEDGER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: { acceptRequestId: 'req-str-1' },
    ledgerPatch: { sourceRequestId: null },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-cancel-mismatch' }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('16. Lock 1 Rejection: offer.acceptRequestId null but debit.sourceRequestId string fails with LEDGER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: { acceptRequestId: null },
    ledgerPatch: { sourceRequestId: 'req-str-1' },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-cancel-mismatch2' }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('17. Lock 1 Rejection: different non-null strings between offer and debit fails with LEDGER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: { acceptRequestId: 'req-1' },
    ledgerPatch: { sourceRequestId: 'req-2' },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-cancel-diff' }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

// ── Lock 2: Chronology & Debit Timestamp Binding ────────────────────────────

test('18. Lock 2: offer.offeredAt >= offer.expiresAt fails closed with LIFECYCLE_TIMESTAMP_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    offerPatch: {
      offeredAt: FakeTimestamp.fromMillis(nowMs + 1000),
      expiresAt: FakeTimestamp.fromMillis(nowMs + 1000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-chron-1' }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('19. Lock 2: offer.acceptedAt >= offer.expiresAt fails closed with LIFECYCLE_TIMESTAMP_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    offerPatch: {
      acceptedAt: FakeTimestamp.fromMillis(nowMs + 20000),
      expiresAt: FakeTimestamp.fromMillis(nowMs + 15000),
    },
    jobPatch: {
      acceptedAt: FakeTimestamp.fromMillis(nowMs + 20000),
    },
    ledgerPatch: {
      createdAt: FakeTimestamp.fromMillis(nowMs + 20000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-chron-2' }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('20. Lock 2: job.acceptedAt !== offer.acceptedAt fails closed with LIFECYCLE_TIMESTAMP_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    jobPatch: {
      acceptedAt: FakeTimestamp.fromMillis(nowMs - 15000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-chron-3' }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('21. Lock 2: debit.createdAt !== job.acceptedAt fails closed with LEDGER_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    ledgerPatch: {
      createdAt: FakeTimestamp.fromMillis(nowMs - 15000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-chron-4' }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  assert.deepEqual(db.data, beforeDb);
});

// ── Customer Precedence ───────────────────────────────────────────────────

test('22. Customer cancellation precedence: pending customer cancellation marker returns cancelled:false with zero writes and no receipt', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: {
      cancelledBy: 'customer',
      cancellationReason: 'customer_requested',
      cancellationResolutionState: 'pending',
      cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 1000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-prec-1',
  });

  assert.equal(res.cancelled, false);
  assert.equal(res.reason, 'customer_cancellation_in_progress');
  assert.equal(res.jobId, jobId);
  assert.equal(res.offerId, offerId);
  assert.equal(res.driverId, driverId);

  assert.deepEqual(db.data, beforeDb);
  assert.equal(db.data.processed_requests['req-prec-1'], undefined);
});
test('23. Customer cancellation precedence: terminal cancelled_customer returns cancelled:false with zero writes and no receipt', async () => {
  const resolvedAt = FakeTimestamp.fromMillis(1757184000000 - 1000);
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: {
      status: 'cancelled_customer',
      dispatchState: 'closed',
      cancelledBy: 'customer',
      cancellationReason: 'customer_requested',
      cancellationResolutionState: 'resolved',
      cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 2000),
      cancellationResolvedAt: resolvedAt,
      cancelledAt: resolvedAt,
    },
    offerPatch: {
      status: 'cancelled_customer',
      resolutionReason: 'customer_cancelled',
      resolvedAt,
    },
    runPatch: {
      status: 'cancelled_customer',
      currentOfferId: 'offer_test_1',
      finalizedAt: resolvedAt,
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-prec-2',
  });

  assert.equal(res.cancelled, false);
  assert.equal(res.reason, 'customer_cancellation_in_progress');
  assert.deepEqual(db.data, beforeDb);
  assert.equal(db.data.processed_requests['req-prec-2'], undefined);
});

// ── Accepted-Only Restriction ─────────────────────────────────────────────

test('24. Job in in_progress fails with JOB_NOT_ACCEPTED and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    jobPatch: {
      status: 'in_progress',
      inProgressAt: FakeTimestamp.fromMillis(nowMs - 10000),
    },
    offerPatch: {
      status: 'in_progress',
      inProgressAt: FakeTimestamp.fromMillis(nowMs - 10000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-inprog-1' }),
    err => err instanceof DispatchError && err.code === 'JOB_NOT_ACCEPTED'
  );

  assert.deepEqual(db.data, beforeDb);
});

test('25. Job in completed fails with JOB_NOT_ACCEPTED and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    jobPatch: {
      status: 'completed',
      completedAt: FakeTimestamp.fromMillis(nowMs - 5000),
    },
  });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-1' }),
    err => err instanceof DispatchError && err.code === 'JOB_NOT_ACCEPTED'
  );

  assert.deepEqual(db.data, beforeDb);
});

// ── Mutation Completeness & Schema Conformance ────────────────────────────

test('26. Atomic 6-document mutation creates exact schema conformant records', async () => {
  let cascadeJobId = null;
  const mockDispatchService = {
    processDispatchJob: async id => { cascadeJobId = id; },
  };

  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
    dispatchService: mockDispatchService,
  });

  const requestId = 'req-exact-schema';
  const res = await manager.cancelJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId,
  });

  assert.equal(res.cancelled, true);
  assert.equal(cascadeJobId, jobId);

  // 1. Job doc
  const job = db.data.jobs[jobId];
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');
  assert.equal(job.assignedDriver, null);
  assert.equal(job.currentOfferId, null);
  assert.equal(job.offeredTo, null);
  assert.equal(job.offeredAt, null);
  assert.equal(job.offerExpiresAt, null);
  assert.equal(job.acceptedAt, null);
  assert.equal(job.commissionDebitEntryId, null);
  assert.equal(job.dispatchLeaseOwner, null);
  assert.equal(job.dispatchLeaseUntil, null);
  assert.equal(job.stateVersion, 2);
  assert.equal(job.forfeitedAmount, 0);

  // 2. Offer doc
  const offer = db.data.job_offers[offerId];
  assert.equal(offer.status, 'cancelled_driver');
  assert.equal(offer.resolutionReason, 'driver_cancelled');
  assert.ok(offer.resolvedAt);

  // 3. Run doc
  const run = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.equal(run.status, 'active');
  assert.equal(run.currentOfferId, null);
  assert.equal(run.candidates[0].outcome, 'driver_cancelled');
  assert.deepEqual(run.excludedDriverIds, [driverId]);
  assert.equal(run.nextCandidateIndex, 1);

  // 4. Driver doc
  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.walletBalance, 25000);
  assert.equal(driverDoc.monthlyCancelCount.count, 1);

  // 5. Credit ledger
  const creditDoc = db.data.wallet_entries['driver_cancel_credit:' + jobId + ':' + offerId];
  assert.ok(exactKeys(creditDoc, WALLET_EXACT_KEYS));
  assert.ok(exactKeys(creditDoc.cancellationPolicyEvidence, CANCELLATION_EVIDENCE_EXACT_KEYS));

  // 6. Receipt doc
  const receiptDoc = db.data.processed_requests[requestId];
  assert.equal(receiptDoc.operation, 'driver_cancel');
  assert.equal(receiptDoc.actorUid, driverId);
  assert.equal(receiptDoc.status, 'completed');
  assert.equal(receiptDoc.result.cancelled, true);
});

// ── Callable Interface ────────────────────────────────────────────────────

test('27. Callable rejects unauthenticated caller with unauthenticated HttpsError', async () => {
  const mockManager = createCancelJobManager({
    db: new FakeFirestore(),
    TimestampClass: FakeTimestamp,
  });
  const callable = createCancelJobCallable({ cancelJobManager: mockManager });
  await assert.rejects(
    callable.run({ auth: null, data: { jobId: 'j', offerId: 'o', requestId: 'r' } }),
    err => err.code === 'unauthenticated'
  );
});


test('28. Callable wraps DispatchErrors into appropriate HttpsError codes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { assignedDriver: 'different_driver' },
  });

  const manager = createCancelJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  const callable = createCancelJobCallable({ cancelJobManager: manager });

  await assert.rejects(
    callable.run({
      auth: { uid: driverId },
      data: { jobId, offerId, requestId: 'req-call-1' },
    }),
    err => err.code === 'permission-denied' && err.message === 'WRONG_DRIVER'
  );
});

// ── Audit Regression Cases (Blockers 1 - 8) ──────────────────────────────

// 1. Lone cancellationRequestedAt
test('29. Blocker 1: Lone cancellationRequestedAt fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 1000) },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-1' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 2. Each partial cancellation provenance combination
test('30. Blocker 1: Partial customer cancellation provenance combinations fail closed with zero writes', async () => {
  const partials = [
    { cancelledBy: 'customer' },
    { cancelledBy: 'customer', cancellationReason: 'customer_requested' },
    { cancellationResolutionState: 'pending' },
    { cancelledBy: 'customer', cancellationReason: 'customer_requested', cancellationResolutionState: 'pending' }, // missing timestamp
    { status: 'cancelled_customer', dispatchState: 'assigned' },
    { status: 'cancelled_customer', dispatchState: 'cancelled_customer', cancellationResolutionState: 'pending' },
  ];

  for (let i = 0; i < partials.length; i++) {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      jobPatch: partials[i],
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: `req-reg-partial-${i}` }),
      err => err instanceof DispatchError && (err.code === 'ACCEPTANCE_CONFLICT' || err.code === 'JOB_NOT_ACCEPTED')
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 3. Malformed monthlyCancelCount map
test('31. Blocker 2: Malformed monthlyCancelCount map fails closed with DRIVER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    driverPatch: { monthlyCancelCount: { count: 0 } }, // missing month
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-3' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 4. Malformed month syntax
test('32. Blocker 2: Malformed month syntax in monthlyCancelCount fails closed with DRIVER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    driverPatch: { monthlyCancelCount: { month: '2026/04', count: 0 } },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-4' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 5. String count
test('33. Blocker 2: String count in monthlyCancelCount fails closed with DRIVER_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: { monthlyCancelCount: { month: getIstMonthString(nowMs), count: '5' } },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-5' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 6. MAX_SAFE count
test('34. Blocker 2: Current month MAX_SAFE_INTEGER count in monthlyCancelCount fails closed with DRIVER_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: { monthlyCancelCount: { month: getIstMonthString(nowMs), count: Number.MAX_SAFE_INTEGER } },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-6' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

test('34B. Blocker 2: Old month MAX_SAFE_INTEGER count lazily resets to 0 and succeeds as count 1', async () => {
  const nowMs = 1757184000000; // '2025-09'
  const { db, jobId, offerId, driverId } = setupAcceptedSeed({
    nowMs,
    driverPatch: { monthlyCancelCount: { month: '2025-08', count: Number.MAX_SAFE_INTEGER } },
  });
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-6b' });
  assert.equal(res.cancelled, true);
  assert.equal(res.forfeitedPaise, 0); // 1st cancellation in new month is free
  assert.equal(res.refundPaise, 5000);
  assert.deepEqual(db.data.drivers[driverId].monthlyCancelCount, {
    month: getIstMonthString(nowMs),
    count: 1,
  });
});

// 7. Malformed strictMode
test('35. Blocker 2: String strictMode fails closed with DRIVER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    driverPatch: { strictMode: 'true' },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-7' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 8. Malformed bannedUntil
test('36. Blocker 2: String bannedUntil fails closed with DRIVER_INVALID and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    driverPatch: { bannedUntil: 'tomorrow' },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-8' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 9. Malformed capability fields
test('37. Blocker 2: Malformed capability fields fail closed with DRIVER_INVALID and zero writes', async () => {
  const capabilityPatches = [
    { canFlatbed: 'true' },
    { canPulling: 1 },
    { isOnDuty: 'yes' },
    { verificationStatus: 123 },
    { verificationStatus: '' },
    { truckType: 123 },
    { truckType: '' },
  ];

  for (let i = 0; i < capabilityPatches.length; i++) {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      driverPatch: capabilityPatches[i],
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: `req-reg-cap-${i}` }),
      err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

test('37B. Driver Eligibility vs Schema Integrity: off-duty or pending/rejected driver CAN cancel already accepted job; invalid enum fails closed', async () => {
  // A. Off-duty driver (isOnDuty: false)
  const { db: dbOff, jobId: jOff, offerId: oOff, driverId: dOff, nowMs: msOff } = setupAcceptedSeed({
    driverPatch: { isOnDuty: false },
  });
  const mgrOff = createCancelJobManager({ db: dbOff, TimestampClass: FakeTimestamp, now: () => new Date(msOff) });
  const resOff = await mgrOff.cancelJob({ jobId: jOff, offerId: oOff, driverUid: dOff, requestId: 'req-off-duty' });
  assert.equal(resOff.cancelled, true);

  // B. Pending verification status CAN cancel
  const { db: dbPend, jobId: jPend, offerId: oPend, driverId: dPend, nowMs: msPend } = setupAcceptedSeed({
    driverPatch: { verificationStatus: 'pending' },
  });
  const mgrPend = createCancelJobManager({ db: dbPend, TimestampClass: FakeTimestamp, now: () => new Date(msPend) });
  const resPend = await mgrPend.cancelJob({ jobId: jPend, offerId: oPend, driverUid: dPend, requestId: 'req-pending' });
  assert.equal(resPend.cancelled, true);

  // C. Rejected verification status CAN cancel
  const { db: dbRej, jobId: jRej, offerId: oRej, driverId: dRej, nowMs: msRej } = setupAcceptedSeed({
    driverPatch: { verificationStatus: 'rejected' },
  });
  const mgrRej = createCancelJobManager({ db: dbRej, TimestampClass: FakeTimestamp, now: () => new Date(msRej) });
  const resRej = await mgrRej.cancelJob({ jobId: jRej, offerId: oRej, driverUid: dRej, requestId: 'req-rejected' });
  assert.equal(resRej.cancelled, true);

  // D. Invalid verificationStatus: 'suspended' and 'bogus' fail closed with DRIVER_INVALID and zero writes
  for (const badStatus of ['suspended', 'bogus']) {
    const { db: dbBad, jobId: jBad, offerId: oBad, driverId: dBad, nowMs: msBad } = setupAcceptedSeed({
      driverPatch: { verificationStatus: badStatus },
    });
    const beforeDb = captureFullDbSnapshot(dbBad);
    const mgrBad = createCancelJobManager({ db: dbBad, TimestampClass: FakeTimestamp, now: () => new Date(msBad) });
    await assert.rejects(
      mgrBad.cancelJob({ jobId: jBad, offerId: oBad, driverUid: dBad, requestId: 'req-bad-status' }),
      err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
    );
    assert.deepEqual(dbBad.data, beforeDb);
  }

  // E. Valid truck types: 'flatbed', 'tochan', 'hydraulic', 'crane' all succeed
  for (const validTruck of ['flatbed', 'tochan', 'hydraulic', 'crane']) {
    const { db: dbTruck, jobId: jTruck, offerId: oTruck, driverId: dTruck, nowMs: msTruck } = setupAcceptedSeed({
      driverPatch: { truckType: validTruck },
    });
    const mgrTruck = createCancelJobManager({ db: dbTruck, TimestampClass: FakeTimestamp, now: () => new Date(msTruck) });
    const resTruck = await mgrTruck.cancelJob({ jobId: jTruck, offerId: oTruck, driverUid: dTruck, requestId: 'req-truck-' + validTruck });
    assert.equal(resTruck.cancelled, true);
  }

  // F. Invalid truckType fails closed with DRIVER_INVALID and zero writes
  const { db: dbBadTruck, jobId: jBadTruck, offerId: oBadTruck, driverId: dBadTruck, nowMs: msBadTruck } = setupAcceptedSeed({
    driverPatch: { truckType: 'bogus' },
  });
  const beforeBadTruckDb = captureFullDbSnapshot(dbBadTruck);
  const mgrBadTruck = createCancelJobManager({ db: dbBadTruck, TimestampClass: FakeTimestamp, now: () => new Date(msBadTruck) });
  await assert.rejects(
    mgrBadTruck.cancelJob({ jobId: jBadTruck, offerId: oBadTruck, driverUid: dBadTruck, requestId: 'req-bad-truck' }),
    err => err instanceof DispatchError && err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(dbBadTruck.data, beforeBadTruckDb);
});

// 10. MAX_SAFE-near commission arithmetic
test('38. Blocker 3: MAX_SAFE-near commission arithmetic rounds exactly without precision loss', async () => {
  const nearMax = 9007199254740990;
  const res30 = calculateForfeitureHalfUp(nearMax, 30);
  assert.equal(res30.forfeiturePaise, 2702159776422297);
  assert.equal(res30.creditPaise, 6305039478318693);
  assert.equal(res30.forfeiturePaise + res30.creditPaise, nearMax);

  // Exact half rounding: 1255 * 30% = 376.5 -> 377
  const resOdd = calculateForfeitureHalfUp(1255, 30);
  assert.equal(resOdd.forfeiturePaise, 377);
  assert.equal(resOdd.creditPaise, 878);
  assert.equal(resOdd.forfeiturePaise + resOdd.creditPaise, 1255);
});

// 11. 100% exact forfeiture
test('39. Blocker 3: 100% forfeiture results in exact 0 credit, no 1-paise leak, even near MAX_SAFE', async () => {
  const nearMax = 9007199254740990;
  const res100 = calculateForfeitureHalfUp(nearMax, 100);
  assert.equal(res100.forfeiturePaise, nearMax);
  assert.equal(res100.creditPaise, 0);
  assert.equal(res100.forfeiturePaise + res100.creditPaise, nearMax);
});

// 12. Wallet addition overflow
test('40. Blocker 4: Wallet addition overflow fails closed with WALLET_OVERFLOW and zero writes', async () => {
  // A. Overflow beyond MAX_SAFE_INTEGER fails
  const { db: db1, jobId: j1, offerId: o1, driverId: d1, nowMs: ms1 } = setupAcceptedSeed({
    driverPatch: { walletBalance: Number.MAX_SAFE_INTEGER }, // credit of 5000 would exceed MAX_SAFE_INTEGER
  });
  const beforeDb1 = captureFullDbSnapshot(db1);
  const manager1 = createCancelJobManager({ db: db1, TimestampClass: FakeTimestamp, now: () => new Date(ms1) });

  await assert.rejects(
    manager1.cancelJob({ jobId: j1, offerId: o1, driverUid: d1, requestId: 'req-reg-12a' }),
    err => err instanceof DispatchError && err.code === 'WALLET_OVERFLOW'
  );
  assert.deepEqual(db1.data, beforeDb1);

  // B. Exact MAX_SAFE boundary succeeds
  const { db: db2, jobId: j2, offerId: o2, driverId: d2, nowMs: ms2 } = setupAcceptedSeed({
    driverPatch: { walletBalance: Number.MAX_SAFE_INTEGER - 5000 },
  });
  const manager2 = createCancelJobManager({ db: db2, TimestampClass: FakeTimestamp, now: () => new Date(ms2) });
  const res2 = await manager2.cancelJob({ jobId: j2, offerId: o2, driverUid: d2, requestId: 'req-reg-12b' });
  assert.equal(res2.cancelled, true);
  assert.equal(db2.data.drivers[d2].walletBalance, Number.MAX_SAFE_INTEGER);
  assert.equal(db2.data.wallet_entries['driver_cancel_credit:' + j2 + ':' + o2].balanceAfterPaise, Number.MAX_SAFE_INTEGER);

  // C. MAX_SAFE + 1 fails
  const { db: db3, jobId: j3, offerId: o3, driverId: d3, nowMs: ms3 } = setupAcceptedSeed({
    driverPatch: { walletBalance: Number.MAX_SAFE_INTEGER - 4999 },
  });
  const beforeDb3 = captureFullDbSnapshot(db3);
  const manager3 = createCancelJobManager({ db: db3, TimestampClass: FakeTimestamp, now: () => new Date(ms3) });
  await assert.rejects(
    manager3.cancelJob({ jobId: j3, offerId: o3, driverUid: d3, requestId: 'req-reg-12c' }),
    err => err instanceof DispatchError && err.code === 'WALLET_OVERFLOW'
  );
  assert.deepEqual(db3.data, beforeDb3);
});

// 13. Stale accepted-job lease
test('41. Blocker 5: Stale accepted-job lease fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { dispatchLeaseOwner: 'stale-worker-owner-token' },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-13' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 14. Malformed dispatch failure / due state
test('42. Blocker 5: Malformed dispatch failure / due state fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { dispatchLastFailure: 'RPC_TIMEOUT' },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-14' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 15. Invalid forfeitedAmount
test('43. Blocker 5: Invalid forfeitedAmount fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { forfeitedAmount: -50 },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-15' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);

  // Historical positive forfeitedAmount on prior redispatch succeeds
  const { db: dbValid, jobId: jV, offerId: oV, driverId: dV, nowMs: msV } = setupAcceptedSeed({
    jobPatch: { forfeitedAmount: 1000 },
  });
  const managerValid = createCancelJobManager({ db: dbValid, TimestampClass: FakeTimestamp, now: () => new Date(msV) });
  const resValid = await managerValid.cancelJob({ jobId: jV, offerId: oV, driverUid: dV, requestId: 'req-reg-15-valid' });
  assert.equal(resValid.cancelled, true);
});

// 16. Missing/invalid refund state
test('44. Blocker 5: Polluted refund state fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    jobPatch: { refundRequestId: 'refund-request-xyz' },
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-16' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 17. Offer/candidate roundIndex mismatch
test('45. Blocker 5: Offer and candidate roundIndex mismatch fails closed with ACCEPTANCE_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: { roundIndex: 2 }, // candidate has roundIndex: 0
  });
  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-reg-17' }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 18. Policy capturedAt mismatch
test('46. Blocker 6: Policy snapshot capturedAt mismatch (+1ms and -1ms) fails closed with LIFECYCLE_TIMESTAMP_INVALID and zero writes', async () => {
  const nowMs = 1757184000000;
  const acceptedAt = FakeTimestamp.fromMillis(nowMs - 20000);

  // +1 ms mismatch
  const { db: db1, jobId: j1, offerId: o1, driverId: d1 } = setupAcceptedSeed({
    nowMs,
    offerPatch: {
      cancellationPolicySnapshot: {
        version: 1,
        timezone: 'Asia/Kolkata',
        roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1,
        forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6,
        banDurationDays: 7,
        capturedAt: FakeTimestamp.fromMillis(acceptedAt.toMillis() + 1),
      },
    },
  });
  const beforeDb1 = captureFullDbSnapshot(db1);
  const manager1 = createCancelJobManager({ db: db1, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  await assert.rejects(
    manager1.cancelJob({ jobId: j1, offerId: o1, driverUid: d1, requestId: 'req-reg-18a' }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(db1.data, beforeDb1);

  // -1 ms mismatch
  const { db: db2, jobId: j2, offerId: o2, driverId: d2 } = setupAcceptedSeed({
    nowMs,
    offerPatch: {
      cancellationPolicySnapshot: {
        version: 1,
        timezone: 'Asia/Kolkata',
        roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1,
        forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6,
        banDurationDays: 7,
        capturedAt: FakeTimestamp.fromMillis(acceptedAt.toMillis() - 1),
      },
    },
  });
  const beforeDb2 = captureFullDbSnapshot(db2);
  const manager2 = createCancelJobManager({ db: db2, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  await assert.rejects(
    manager2.cancelJob({ jobId: j2, offerId: o2, driverUid: d2, requestId: 'req-reg-18b' }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(db2.data, beforeDb2);
});

// 19. Receipt processedAt before claimedAt
test('47. Blocker 7: Receipt with processedAt before claimedAt fails closed with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-reg-19';
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests[requestId] = {
    requestId,
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: FakeTimestamp.fromMillis(nowMs),
    leaseUntil: null,
    processedAt: FakeTimestamp.fromMillis(nowMs - 5000), // processed before claimed!
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: {
      cancelled: true,
      driverId,
      forfeitedPaise: 0,
      jobId,
      offerId,
      refundPaise: 5000,
    },
  };

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err instanceof DispatchError && err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 20. Receipt zero+zero money
test('48. Blocker 7: Receipt with forfeitedPaise=0 AND refundPaise=0 fails closed with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-reg-20';
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  const at = FakeTimestamp.fromMillis(nowMs);

  db.data.processed_requests[requestId] = {
    requestId,
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: {
      cancelled: true,
      driverId,
      forfeitedPaise: 0,
      jobId,
      offerId,
      refundPaise: 0, // 0 + 0 = 0 is invalid
    },
  };

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err instanceof DispatchError && err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 21. Receipt money overflow
test('49. Blocker 7: Receipt with sum exceeding MAX_SAFE_INTEGER fails closed with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed();
  const requestId = 'req-reg-21';
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  const at = FakeTimestamp.fromMillis(nowMs);

  db.data.processed_requests[requestId] = {
    requestId,
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'driver_cancel',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: {
      cancelled: true,
      driverId,
      forfeitedPaise: Number.MAX_SAFE_INTEGER,
      jobId,
      offerId,
      refundPaise: 1, // exceeds MAX_SAFE_INTEGER
    },
  };

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });

  await assert.rejects(
    manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err instanceof DispatchError && err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 22. Extra callable payload property
test('50. Blocker 8A: Extra property in callable payload is rejected with invalid-argument HttpsError', async () => {
  const mockManager = createCancelJobManager({
    db: new FakeFirestore(),
    TimestampClass: FakeTimestamp,
  });
  const callable = createCancelJobCallable({ cancelJobManager: mockManager });

  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_test_1' },
      data: { jobId: 'j', offerId: 'o', requestId: 'r', unexpectedProperty: true },
    }),
    err => err.code === 'invalid-argument'
  );
});

// 23. Wrong driver on customer-pending occurrence
test('51. Blocker 8B: Driver B requesting cancelJob on Driver A customer-pending occurrence fails closed with permission-denied', async () => {
  const { db, jobId, offerId, driverId: driverA, nowMs } = setupAcceptedSeed({
    jobPatch: {
      cancelledBy: 'customer',
      cancellationReason: 'customer_requested',
      cancellationResolutionState: 'pending',
      cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 1000),
    },
  });
  // Seed Driver B
  db.data.drivers['driver_b_uid'] = driver(FakeTimestamp, nowMs, { activeJobId: null, activeOfferId: null });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  const callable = createCancelJobCallable({ cancelJobManager: manager });

  // Driver B tries to cancel Driver A's customer-pending job
  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_b_uid' },
      data: { jobId, offerId, requestId: 'req-reg-23' },
    }),
    err => err.code === 'permission-denied'
  );
  assert.deepEqual(db.data, beforeDb);
});

// 24. Wrong driver on customer-terminal occurrence
test('52. Blocker 8B: Driver B requesting cancelJob on Driver A customer-terminal occurrence fails closed with permission-denied', async () => {
  const { db, jobId, offerId, driverId: driverA, nowMs } = setupAcceptedSeed({
    jobPatch: {
      status: 'cancelled_customer',
      dispatchState: 'closed',
      assignedDriver: null,
      cancelledBy: 'customer',
      cancellationReason: 'customer_requested',
      cancellationResolutionState: 'resolved',
      cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 2000),
      cancellationResolvedAt: FakeTimestamp.fromMillis(1757184000000 - 1000),
      cancelledAt: FakeTimestamp.fromMillis(1757184000000 - 1000),
    },
  });
  // Seed Driver B
  db.data.drivers['driver_b_uid'] = driver(FakeTimestamp, nowMs, { activeJobId: null, activeOfferId: null });

  const beforeDb = captureFullDbSnapshot(db);
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  const callable = createCancelJobCallable({ cancelJobManager: manager });

  // Driver B tries to cancel Driver A's customer-terminal job
  await assert.rejects(
    callable.run({
      auth: { uid: 'driver_b_uid' },
      data: { jobId, offerId, requestId: 'req-reg-24' },
    }),
    err => err.code === 'permission-denied'
  );
  assert.deepEqual(db.data, beforeDb);
});

// ════════════════════════════════════════════════════════════════════════════════
// SECOND NARROW AUDIT REPAIR TESTS (B1 - B5)
// ════════════════════════════════════════════════════════════════════════════════

// 25. B1: Legal null routing projections succeed
test('53. Audit B1: Legal null distance and ETA routing values allow cancelJob to succeed', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: {
      pickupRoutedDistanceMeters: null,
      pickupEtaSeconds: null,
    },
    runPatch: {
      candidates: [{
        driverId: 'driver_test_1',
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: null,
        matrixDistanceMeters: null,
        rankingMode: 'haversine_degraded',
        outcome: 'accepted',
        reasonCode: null,
      }],
    },
  });
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b1-null' });
  assert.equal(res.cancelled, true);
});

// 26. B1: Legal fractional routing projections succeed
test('54. Audit B1: Legal fractional distance (2000.25) and ETA (300.5) allow cancelJob to succeed', async () => {
  const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
    offerPatch: {
      pickupRoutedDistanceMeters: 2000.25,
      pickupEtaSeconds: 300.5,
    },
    runPatch: {
      candidates: [{
        driverId: 'driver_test_1',
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 300.5,
        matrixDistanceMeters: 2000.25,
        rankingMode: 'ola',
        outcome: 'accepted',
        reasonCode: null,
      }],
    },
  });
  const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
  const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b1-frac' });
  assert.equal(res.cancelled, true);
});

// 27. B1/B3: Contradictory offer and candidate routing evidence fails closed
test('55. Audit B1 & B3: Contradictory offer and candidate routing evidence rejects zero-write with ACCEPTANCE_CONFLICT', async () => {
  // A. Distance mismatch
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { pickupRoutedDistanceMeters: 2000.25 },
      runPatch: {
        candidates: [{
          driverId: 'driver_test_1',
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 2000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        }],
      },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-contra-dist' }),
      err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // B. ETA mismatch
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { pickupEtaSeconds: 300.5 },
      runPatch: {
        candidates: [{
          driverId: 'driver_test_1',
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 300,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        }],
      },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-contra-eta' }),
      err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // C. One null, one non-null
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { pickupRoutedDistanceMeters: null },
      runPatch: {
        candidates: [{
          driverId: 'driver_test_1',
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        }],
      },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-contra-null' }),
      err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 28. B3: Enums, coordinates, fare, and timestamp evidence binding
test('56. Audit B3: Malformed accepted offer evidence rejects zero-write', async () => {
  // A. Invalid timeoutTaskState
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { timeoutTaskState: 'bogus' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-bad-timeout' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // B. Invalid requestedTruckType
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { requestedTruckType: 'crane' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-bad-req-truck' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // C. requestedTruckType mismatch with job
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { requestedTruckType: 'pulling' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-mismatch-truck' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // D. Fare mismatch: offer 45001 vs job 45000
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { estimatedFarePaise: 45001 },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-fare-mismatch' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // E. Coordinate contradiction
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { pickupCoords: { lat: 18.5205, lng: 73.8568 } },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-coord-mismatch' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // F. Malformed offer timestamp: non-timestamp createdAt
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      offerPatch: { createdAt: '2026-09-01T00:00:00Z' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-bad-created-at' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // G. Chronology inversion: createdAt > offeredAt
  {
    const nowMs = 1757184000000;
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { createdAt: FakeTimestamp.fromMillis(nowMs - 25000) },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-inv-created' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // H. Chronology inversion: acceptedAt > updatedAt
  {
    const nowMs = 1757184000000;
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { updatedAt: FakeTimestamp.fromMillis(nowMs - 25000) },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-inv-updated' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 29. B4: Terminal customer precedence occurrence validation
test('57. Audit B4: Terminal customer cancellation precedence rejects wrong offer occurrence with zero writes', async () => {
  const resolvedAt = FakeTimestamp.fromMillis(1757184000000 - 1000);

  // A. Correct preserved offer -> returns customer precedence with zero writes
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      jobPatch: {
        status: 'cancelled_customer',
        dispatchState: 'closed',
        assignedDriver: 'driver_test_1',
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationResolutionState: 'resolved',
        cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 2000),
        cancellationResolvedAt: resolvedAt,
        cancelledAt: resolvedAt,
      },
      offerPatch: {
        status: 'cancelled_customer',
        resolutionReason: 'customer_cancelled',
        resolvedAt,
      },
      runPatch: {
        status: 'cancelled_customer',
        currentOfferId: 'offer_test_1',
        finalizedAt: resolvedAt,
      },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b4-correct' });
    assert.equal(res.cancelled, false);
    assert.equal(res.reason, 'customer_cancellation_in_progress');
    assert.deepEqual(db.data, beforeDb);
  }

  // B. Same job + same driver + another historical offer ID rejects with JOB_OFFER_MISMATCH and zero writes
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      jobPatch: {
        status: 'cancelled_customer',
        dispatchState: 'closed',
        assignedDriver: 'driver_test_1',
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationResolutionState: 'resolved',
        cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 2000),
        cancellationResolvedAt: resolvedAt,
        cancelledAt: resolvedAt,
      },
      offerPatch: {
        status: 'cancelled_customer',
        resolutionReason: 'customer_cancelled',
        resolvedAt,
      },
      runPatch: {
        status: 'cancelled_customer',
        currentOfferId: 'offer_test_1',
        finalizedAt: resolvedAt,
      },
    });
    db.data.job_offers['offer_other_hist'] = {
      ...db.data.job_offers[offerId],
      status: 'cancelled_customer',
      resolvedAt,
    };
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId: 'offer_other_hist', driverUid: driverId, requestId: 'req-b4-wrong-offer' }),
      err => err instanceof DispatchError && err.code === 'JOB_OFFER_MISMATCH'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // C. Same job + same driver + offer from another generation rejects with OFFER_GENERATION_MISMATCH and zero writes
  {
    const { db, jobId, offerId, driverId, nowMs } = setupAcceptedSeed({
      jobPatch: {
        status: 'cancelled_customer',
        dispatchState: 'closed',
        assignedDriver: 'driver_test_1',
        cancelledBy: 'customer',
        cancellationReason: 'customer_requested',
        cancellationResolutionState: 'resolved',
        cancellationRequestedAt: FakeTimestamp.fromMillis(1757184000000 - 2000),
        cancellationResolvedAt: resolvedAt,
        cancelledAt: resolvedAt,
      },
      offerPatch: {
        status: 'cancelled_customer',
        resolutionReason: 'customer_cancelled',
        resolvedAt,
        dispatchGeneration: 2,
      },
      runPatch: {
        status: 'cancelled_customer',
        currentOfferId: 'offer_test_1',
        finalizedAt: resolvedAt,
      },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b4-gen-mismatch' }),
      err => err instanceof DispatchError && err.code === 'OFFER_GENERATION_MISMATCH'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 30. B5: Fresh 7-day flat ban reset
test('58. Audit B5: Ban renewal unconditionally sets fresh now + 7 days, overwriting longer ban', async () => {
  const nowMs = 1757184000000;
  const sevenDaysMs = 7 * 86400000;

  // Case 1: Threshold cancellation, no prior ban -> now + 7 days
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      driverPatch: {
        monthlyCancelCount: { month: getIstMonthString(nowMs), count: 5 },
        strictMode: false,
        bannedUntil: null,
      },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b5-1' });
    assert.equal(res.cancelled, true);
    assert.equal(db.data.drivers[driverId].bannedUntil.toMillis(), nowMs + sevenDaysMs);
  }

  // Case 2: Threshold cancellation, prior ban +3 days -> now + 7 days
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      driverPatch: {
        monthlyCancelCount: { month: getIstMonthString(nowMs), count: 5 },
        strictMode: false,
        bannedUntil: FakeTimestamp.fromMillis(nowMs + 3 * 86400000),
      },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b5-2' });
    assert.equal(res.cancelled, true);
    assert.equal(db.data.drivers[driverId].bannedUntil.toMillis(), nowMs + sevenDaysMs);
  }

  // Case 3: Threshold/strict cancellation, prior ban +10 days -> overwritten to now + 7 days exactly!
  {
    const priorBanMs = nowMs + 10 * 86400000;
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      driverPatch: {
        monthlyCancelCount: { month: getIstMonthString(nowMs), count: 6 },
        strictMode: true,
        bannedUntil: FakeTimestamp.fromMillis(priorBanMs),
      },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b5-3' });
    assert.equal(res.cancelled, true);
    assert.equal(db.data.drivers[driverId].bannedUntil.toMillis(), nowMs + sevenDaysMs);
    assert.ok(db.data.drivers[driverId].bannedUntil.toMillis() < priorBanMs);
  }

  // Case 4: Strict subsequent cancellation -> fresh now + 7 days
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      driverPatch: {
        monthlyCancelCount: { month: getIstMonthString(nowMs), count: 7 },
        strictMode: true,
        bannedUntil: FakeTimestamp.fromMillis(nowMs + 2 * 86400000),
      },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b5-4' });
    assert.equal(res.cancelled, true);
    assert.equal(db.data.drivers[driverId].bannedUntil.toMillis(), nowMs + sevenDaysMs);
  }

  // Case 5: Non-banning new-month cancellation with active prior ban -> preserves active prior ban
  {
    const activeBanMs = nowMs + 4 * 86400000;
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      driverPatch: {
        monthlyCancelCount: { month: '2026-08', count: 6 },
        strictMode: true,
        bannedUntil: FakeTimestamp.fromMillis(activeBanMs),
      },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-b5-5' });
    assert.equal(res.cancelled, true);
    assert.equal(res.forfeitedPaise, 0);
    assert.equal(db.data.drivers[driverId].bannedUntil.toMillis(), activeBanMs);
  }
});

// 31. Blocker F1: Timeout task state / ID relational contract
test('59. Blocker F1: Timeout task state and taskId relational contract enforced with zero writes', async () => {
  const nowMs = 1757184000000;
  const jobId = 'job_test_1';
  const offerId = 'offer_test_1';
  const generation = 1;
  const correctTaskId = taskIdForOfferTimeout(jobId, offerId, generation);

  // Case A: normal enqueue -> timeoutTaskState: 'enqueued' with correct taskId succeeds
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'enqueued', timeoutTaskId: correctTaskId },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-enqueued-ok' });
    assert.equal(res.cancelled, true);
  }

  // Case B: enqueue failure / pending -> timeoutTaskState: 'pending' with timeoutTaskId: null succeeds
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'pending', timeoutTaskId: null },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-pending-ok' });
    assert.equal(res.cancelled, true);
  }

  // Case C: pending + ID -> rejects OFFER_INVALID with zero writes
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'pending', timeoutTaskId: correctTaskId },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-pending-with-id' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case D: enqueued + null -> rejects OFFER_INVALID with zero writes
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'enqueued', timeoutTaskId: null },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-enqueued-null' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case E: enqueued + empty -> rejects OFFER_INVALID with zero writes
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'enqueued', timeoutTaskId: '' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-enqueued-empty' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case F: enqueued + wrong deterministic ID -> rejects OFFER_INVALID with zero writes
  {
    const wrongTaskId = taskIdForOfferTimeout('other_job', offerId, generation);
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'enqueued', timeoutTaskId: wrongTaskId },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-wrong-id' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case G: not_required + null -> succeeds; not_required + ID -> rejects OFFER_INVALID with zero writes
  {
    const { db, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { timeoutTaskState: 'not_required', timeoutTaskId: 'task-fake' },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f1-not-required-id' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 32. Blocker F2: Terminal accepted-origin customer provenance
test('60. Blocker F2: Terminal customer cancellation precedence validates accepted-origin provenance and rejects corruptions with zero writes', async () => {
  const nowMs = 1757184000000;
  const acceptedAt = FakeTimestamp.fromMillis(nowMs - 20000);
  const requestedAt = FakeTimestamp.fromMillis(nowMs - 2000);
  const resolvedAt = FakeTimestamp.fromMillis(nowMs - 1000);

  const baseTerminalSeed = () => setupAcceptedSeed({
    nowMs,
    jobPatch: {
      status: 'cancelled_customer',
      dispatchState: 'closed',
      cancelledBy: 'customer',
      cancellationReason: 'customer_requested',
      cancellationResolutionState: 'resolved',
      cancellationRequestedAt: requestedAt,
      cancellationResolvedAt: resolvedAt,
      cancelledAt: resolvedAt,
    },
    offerPatch: {
      status: 'cancelled_customer',
      resolutionReason: 'customer_cancelled',
      resolvedAt,
    },
    runPatch: {
      status: 'cancelled_customer',
      currentOfferId: 'offer_test_1',
      finalizedAt: resolvedAt,
    },
  });

  // Valid canonical accepted-origin terminal customer cancellation returns customer precedence
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-canonical' });
    assert.equal(res.cancelled, false);
    assert.equal(res.reason, 'customer_cancellation_in_progress');
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 1: job.assignedDriver = null -> rejects WRONG_DRIVER with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data.jobs[jobId].assignedDriver = null;
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-no-assigned' }),
      err => err instanceof DispatchError && err.code === 'WRONG_DRIVER'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 2: job.acceptedAt = null -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data.jobs[jobId].acceptedAt = null;
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-job-no-accepted-at' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 3: job.commissionDebitEntryId = null -> rejects LEDGER_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data.jobs[jobId].commissionDebitEntryId = null;
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-no-debit-id' }),
      err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 4: offer.acceptedAt = null -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data.job_offers[offerId].acceptedAt = null;
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-offer-no-accepted-at' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 5: offer.acceptedAt mismatching job.acceptedAt -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data.job_offers[offerId].acceptedAt = FakeTimestamp.fromMillis(acceptedAt.toMillis() + 1);
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-accepted-at-mismatch' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 6: run candidate outcome changed accepted -> offered -> rejects CANCELLATION_CONFLICT with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    db.data['jobs/' + jobId + '/dispatch_runs']['1'].candidates[0].outcome = 'offered';
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-outcome-offered' }),
      err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 7: customer cancellationRequestedAt earlier than acceptance -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    // requestedAt is earlier than acceptedAt (acceptedAt - 1000)
    db.data.jobs[jobId].cancellationRequestedAt = FakeTimestamp.fromMillis(acceptedAt.toMillis() - 1000);
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-req-before-acc' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Corruption 8: missing debit doc -> rejects LEDGER_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = baseTerminalSeed();
    delete db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId];
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f2-missing-debit' }),
      err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 33. Blocker F3: Legal zero informational fare
test('61. Blocker F3: Nonnegative integer fare allows zero, rejects negative/mismatched fares with zero writes', async () => {
  const nowMs = 1757184000000;

  // Case A: 0 fare in job and offer + positive commission succeeds
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { estimatedFarePaise: 0 },
      offerPatch: { estimatedFarePaise: 0 },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f3-zero-fare' });
    assert.equal(res.cancelled, true);
  }

  // Case B: offer fare -1 -> rejects OFFER_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { estimatedFarePaise: 0 },
      offerPatch: { estimatedFarePaise: -1 },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f3-neg-fare' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case C: job fare 0 / offer fare 1 -> rejects OFFER_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { estimatedFarePaise: 0 },
      offerPatch: { estimatedFarePaise: 1 },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f3-mismatch-0-1' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case D: job fare 1 / offer fare 0 -> rejects OFFER_INVALID with zero writes
  {
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { estimatedFarePaise: 1 },
      offerPatch: { estimatedFarePaise: 0 },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f3-mismatch-1-0' }),
      err => err instanceof DispatchError && err.code === 'OFFER_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case E: MAX_SAFE_INTEGER fare in both -> succeeds
  {
    const maxFare = Number.MAX_SAFE_INTEGER;
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { estimatedFarePaise: maxFare },
      offerPatch: { estimatedFarePaise: maxFare },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f3-max-fare' });
    assert.equal(res.cancelled, true);
  }
});

// 34. Blocker F4: Exact 45-second immutable offer lifetime
test('62. Blocker F4: Exact 45-second offer lifetime enforced down to exact seconds and nanoseconds with zero writes', async () => {
  const nowMs = 1757184000000;
  const offeredAt = FakeTimestamp.fromMillis(nowMs - 30000);

  // Case A: exact 45s -> succeeds
  {
    const expiresAt = FakeTimestamp.fromMillis(offeredAt.toMillis() + 45000);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { offeredAt, expiresAt },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f4-exact-45s' });
    assert.equal(res.cancelled, true);
  }

  // Case B: 44,999 ms -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const expiresAt = FakeTimestamp.fromMillis(offeredAt.toMillis() + 44999);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { offeredAt, expiresAt },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f4-44999ms' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case C: 45,001 ms -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const expiresAt = FakeTimestamp.fromMillis(offeredAt.toMillis() + 45001);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { offeredAt, expiresAt },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f4-45001ms' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case D: Nanosecond mismatch (+1000 nanos) -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const expiresAt = new FakeTimestamp(offeredAt.seconds + 45, offeredAt.nanoseconds + 1000);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      offerPatch: { offeredAt, expiresAt },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f4-nanos-mismatch' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});

// 35. Blocker F5: Cancellation event must not precede acceptance
test('63. Blocker F5: Cancellation event must not precede acceptance evidence, rejecting with zero writes', async () => {
  const nowMs = 1757184000000;

  // Case A: acceptedAt < cancellationEventAt -> succeeds
  {
    const acceptedAt = FakeTimestamp.fromMillis(nowMs - 5000);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { acceptedAt },
      offerPatch: { acceptedAt, updatedAt: acceptedAt, cancellationPolicySnapshot: {
        version: 1, timezone: 'Asia/Kolkata', roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1, forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6, banDurationDays: 7, capturedAt: acceptedAt,
      }},
      ledgerPatch: { createdAt: acceptedAt },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f5-before-ok' });
    assert.equal(res.cancelled, true);
  }

  // Case B: acceptedAt == cancellationEventAt -> succeeds
  {
    const acceptedAt = FakeTimestamp.fromMillis(nowMs);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { acceptedAt },
      offerPatch: { acceptedAt, updatedAt: acceptedAt, cancellationPolicySnapshot: {
        version: 1, timezone: 'Asia/Kolkata', roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1, forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6, banDurationDays: 7, capturedAt: acceptedAt,
      }},
      ledgerPatch: { createdAt: acceptedAt },
    });
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    const res = await manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f5-equal-ok' });
    assert.equal(res.cancelled, true);
  }

  // Case C: acceptedAt == cancellationEventAt + 1ms -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const futureAcceptedAt = FakeTimestamp.fromMillis(nowMs + 1);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { acceptedAt: futureAcceptedAt },
      offerPatch: { acceptedAt: futureAcceptedAt, updatedAt: futureAcceptedAt, cancellationPolicySnapshot: {
        version: 1, timezone: 'Asia/Kolkata', roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1, forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6, banDurationDays: 7, capturedAt: futureAcceptedAt,
      }},
      ledgerPatch: { createdAt: futureAcceptedAt },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f5-future-ms' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }

  // Case D: acceptedAt nanoseconds > cancellationEventAt nanoseconds -> rejects LIFECYCLE_TIMESTAMP_INVALID with zero writes
  {
    const eventSec = Math.floor(nowMs / 1000);
    const eventNano = Math.floor((nowMs % 1000) * 1e6);
    const futureAcceptedAt = new FakeTimestamp(eventSec, eventNano + 1000);
    const { db, jobId, offerId, driverId } = setupAcceptedSeed({
      nowMs,
      jobPatch: { acceptedAt: futureAcceptedAt },
      offerPatch: { acceptedAt: futureAcceptedAt, updatedAt: futureAcceptedAt, cancellationPolicySnapshot: {
        version: 1, timezone: 'Asia/Kolkata', roundingMode: 'HALF_UP',
        freeCancellationsPerMonth: 1, forfeitPctByCount: { '2': 20, '3': 30, '4': 40, '5': 50 },
        banThresholdCount: 6, banDurationDays: 7, capturedAt: futureAcceptedAt,
      }},
      ledgerPatch: { createdAt: futureAcceptedAt },
    });
    const beforeDb = captureFullDbSnapshot(db);
    const manager = createCancelJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs) });
    await assert.rejects(
      manager.cancelJob({ jobId, offerId, driverUid: driverId, requestId: 'req-f5-future-nanos' }),
      err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
    );
    assert.deepEqual(db.data, beforeDb);
  }
});
