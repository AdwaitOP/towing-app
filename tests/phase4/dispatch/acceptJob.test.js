'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { GeoPoint } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createAcceptJobManager,
  getDefaultAcceptJobManager,
  createAcceptJobCallable,
  acceptJob,
} = require('../../../firebase/functions/src/dispatch/acceptJob');
const { POLICY_KEYS } = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const { paidJob, driver, config } = require('../fixtures');

function cloneDb(data) {
  if (data === undefined || data === null) return data;
  if (data instanceof FakeTimestamp) return new FakeTimestamp(data.toMillis());
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

function setupSeed({
  nowMs = 1000000,
  offerLifetimeMs = 45000,
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
  configPatch = {},
} = {}) {
  const jobId = 'job_test_1';
  const driverId = 'driver_test_1';
  const generation = 1;
  const offerId = 'offer_test_1';
  const offeredAt = FakeTimestamp.fromMillis(nowMs);
  const expiresAt = FakeTimestamp.fromMillis(nowMs + offerLifetimeMs);

  const job = paidJob(FakeTimestamp, nowMs, {
    status: 'offered',
    dispatchState: 'offered',
    offeredTo: driverId,
    currentOfferId: offerId,
    offeredAt,
    offerExpiresAt: expiresAt,
    dispatchGeneration: generation,
    dispatchRunId: '1',
    stateVersion: 1,
    driverCommissionPaise: 5000,
    requestedTruckType: 'flatbed',
    assignedDriver: null,
    acceptedAt: null,
    commissionDebitEntryId: null,
    cancellationResolutionState: 'none',
    cancellationRequestedAt: null,
    cancellationResolvedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    ...jobPatch,
  });

  const driverDoc = driver(FakeTimestamp, nowMs, {
    activeOfferId: offerId,
    activeJobId: null,
    walletBalance: 25000,
    verificationStatus: 'approved',
    isOnDuty: true,
    canFlatbed: true,
    canPulling: false,
    bannedUntil: null,
    ...driverPatch,
  });

  const offer = {
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
    pickupCoords: job.pickupCoords,
    destCoords: job.destCoords,
    requestedTruckType: job.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: 250000,
    driverCommissionPaise: 5000,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    ...offerPatch,
  };

  const fullConfig = config(FakeTimestamp, nowMs);
  const policySnapshot = Object.fromEntries(POLICY_KEYS.map(key => [key, fullConfig[key]]));

  const run = {
    jobId,
    generation,
    policyVersion: 1,
    status: 'active',
    policySnapshot,
    candidates: [{
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'offered',
      reasonCode: null,
    }],
    nextCandidateIndex: 1,
    currentOfferId: offerId,
    attemptedDriverIds: [driverId],
    excludedDriverIds: [],
    finalizedAt: null,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    ...runPatch,
  };

  const db = new FakeFirestore();
  db.data.jobs = { [jobId]: job };
  db.data.drivers = { [driverId]: driverDoc };
  db.data.job_offers = { [offerId]: offer };
  db.data['jobs/' + jobId + '/dispatch_runs'] = { [String(generation)]: run };
  db.data.pricing_config = {
    main: {
      cancellation_policy: {
        version: 1,
        timezone: 'Asia/Kolkata',
        roundingMode: 'HALF_UP',
        free_cancellations_per_month: 1,
        forfeit_pct_by_count: {
          '2': 20,
          '3': 40,
          '4': 60,
          '5': 80,
        },
        ban_threshold_count: 6,
        ban_duration_days: 7,
      },
      ...configPatch,
    },
  };
  db.data.wallet_entries = {};
  db.data.notification_outbox = {};
  db.data.processed_requests = {};

  return { db, jobId, driverId, offerId, generation, nowMs, offeredAt, expiresAt };
}

// ============================================================================
// BASELINE TESTS 1 - 24
// ============================================================================

test('1. Valid acceptance creates expected atomic state, ledger, and outbox', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  const res = await manager.acceptJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req_123',
  });

  assert.equal(res.accepted, true);
  assert.equal(res.jobId, jobId);
  assert.equal(res.offerId, offerId);
  assert.equal(res.driverId, driverId);

  const updatedJob = db.data.jobs[jobId];
  assert.equal(updatedJob.status, 'accepted');
  assert.equal(updatedJob.dispatchState, 'assigned');
  assert.equal(updatedJob.assignedDriver, driverId);
  assert.equal(updatedJob.offeredTo, null);
  assert.equal(updatedJob.offeredAt, null);
  assert.equal(updatedJob.offerExpiresAt, null);
  assert.equal(updatedJob.commissionDebitEntryId, 'commission_debit:' + jobId + ':' + offerId);
  assert.equal(updatedJob.stateVersion, 2);

  const updatedOffer = db.data.job_offers[offerId];
  assert.equal(updatedOffer.status, 'accepted');
  assert.equal(updatedOffer.acceptRequestId, 'req_123');
  assert.ok(updatedOffer.cancellationPolicySnapshot);
  assert.equal(updatedOffer.cancellationPolicySnapshot.version, 1);
  assert.equal(updatedOffer.cancellationPolicySnapshot.timezone, 'Asia/Kolkata');

  const updatedRun = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.equal(updatedRun.status, 'assigned');
  assert.equal(updatedRun.candidates[0].outcome, 'accepted');
  assert.equal(updatedRun.currentOfferId, offerId);

  const updatedDriver = db.data.drivers[driverId];
  assert.equal(updatedDriver.activeOfferId, null);
  assert.equal(updatedDriver.activeJobId, jobId);
  assert.equal(updatedDriver.walletBalance, 20000);

  const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
  const ledger = db.data.wallet_entries[ledgerId];
  assert.ok(ledger);
  assert.equal(ledger.operationId, ledgerId);
  assert.equal(ledger.driverId, driverId);
  assert.equal(ledger.jobId, jobId);
  assert.equal(ledger.offerId, offerId);
  assert.equal(ledger.type, 'commission_debit');
  assert.equal(ledger.commissionPaise, 5000);
  assert.equal(ledger.deltaPaise, -5000);
  assert.equal(ledger.balanceBeforePaise, 25000);
  assert.equal(ledger.balanceAfterPaise, 20000);
  assert.equal(ledger.sourceRequestId, 'req_123');
  assert.equal(ledger.sourceType, 'driver');
  assert.equal(ledger.actorUid, driverId);

  const outboxId = 'job_accepted:' + jobId + ':' + offerId;
  const outbox = db.data.notification_outbox[outboxId];
  assert.ok(outbox);
  assert.equal(outbox.eventId, outboxId);
  assert.equal(outbox.eventType, 'job_accepted');
  assert.equal(outbox.resourceId, jobId);
  assert.equal(outbox.state, 'pending');
  assert.deepEqual(outbox.payload, {
    jobId,
    jobStatus: 'accepted',
    refundAmountPaise: null,
  });

  const receipt = db.data.processed_requests['req_123'];
  assert.ok(receipt);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actorUid, driverId);
  assert.equal(receipt.operation, 'accept');
  assert.equal(receipt.resourceId, jobId + ':' + offerId);
});

test('2. Unauthenticated driver throws unauthenticated HttpsError', async () => {
  const { db } = setupSeed();
  const manager = createAcceptJobManager({ db });
  const callable = createAcceptJobCallable({ acceptJobManager: manager });

  await assert.rejects(
    () => callable.run({ data: { jobId: 'j1', offerId: 'o1' }, auth: null }),
    err => err.code === 'unauthenticated'
  );
});

test('3. Wrong driver UID fails with WRONG_DRIVER and 0 writes', async () => {
  const { db, jobId, offerId, nowMs } = setupSeed();
  db.data.drivers['driver_wrong'] = cloneDb(db.data.drivers['driver_test_1']);
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: 'driver_wrong' }),
    err => err.code === 'WRONG_DRIVER'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('4. Offer binding mismatch fails with OFFER_BINDING_MISMATCH and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { jobId: 'other_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'OFFER_BINDING_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('5. Wrong generation fails with OFFER_GENERATION_MISMATCH and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { dispatchGeneration: 2 },
  });
  db.data['jobs/' + jobId + '/dispatch_runs']['2'] = cloneDb(db.data['jobs/' + jobId + '/dispatch_runs']['1']);
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'OFFER_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('6. Malformed run fails with RUN_INVALID and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    runPatch: { finalizedAt: FakeTimestamp.fromMillis(nowMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('7. Candidate mismatch fails with CANDIDATE_DRIVER_MISMATCH and 0 writes', async () => {
  const candidate = {
    driverId: 'other_driver',
    roundIndex: 0,
    haversineDistanceKm: 3.5,
    matrixEtaSeconds: 600,
    matrixDistanceMeters: 5000,
    rankingMode: 'ola',
    outcome: 'offered',
    reasonCode: null,
  };
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    runPatch: { candidates: [candidate] },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANDIDATE_DRIVER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('8. Candidate outcome conflict fails with CANDIDATE_OUTCOME_CONFLICT and 0 writes', async () => {
  const candidate = {
    driverId: 'driver_test_1',
    roundIndex: 0,
    haversineDistanceKm: 3.5,
    matrixEtaSeconds: 600,
    matrixDistanceMeters: 5000,
    rankingMode: 'ola',
    outcome: 'declined',
    reasonCode: null,
  };
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    runPatch: { candidates: [candidate] },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANDIDATE_OUTCOME_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('9. Driver engagement mismatch fails with DRIVER_ENGAGEMENT_MISMATCH and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { activeOfferId: 'other_offer' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('10. Active job conflict fails with ACTIVE_JOB_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { activeJobId: 'existing_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACTIVE_JOB_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('11. Insufficient wallet balance fails with INSUFFICIENT_WALLET_BALANCE and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { walletBalance: 4000 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'INSUFFICIENT_WALLET_BALANCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('12. Exact wallet balance == commission succeeds and balance becomes 0', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { walletBalance: 5000 },
  });
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(db.data.drivers[driverId].walletBalance, 0);
  const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
  assert.equal(db.data.wallet_entries[ledgerId].balanceBeforePaise, 5000);
  assert.equal(db.data.wallet_entries[ledgerId].balanceAfterPaise, 0);
});

test('13. Wallet balance 1 paise below commission fails with INSUFFICIENT_WALLET_BALANCE and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { walletBalance: 4999 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'INSUFFICIENT_WALLET_BALANCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('14. Malformed wallet balance fails with WALLET_BALANCE_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { walletBalance: '5000' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'WALLET_BALANCE_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('15. Malformed driverCommissionPaise fails with COMMISSION_PAISE_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { driverCommissionPaise: 0 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'COMMISSION_PAISE_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('16. Offer expired fails with OFFER_EXPIRED and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerLifetimeMs: 45000,
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 45001),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'OFFER_EXPIRED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('17. Exact expiry instant boundary (now === expiresAt) fails with OFFER_EXPIRED and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerLifetimeMs: 45000,
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 45000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'OFFER_EXPIRED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('18. Customer cancellation request takes precedence with CANCELLATION_PRECEDENCE and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs + 500),
      cancellationResolutionState: 'pending',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('19. Contradictory cancellation provenance fails with CANCELLATION_PROVENANCE_CONFLICT and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs + 500),
      cancellationResolutionState: 'none',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_PROVENANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('20. State version >= MAX_SAFE_INTEGER fails with JOB_STATE_VERSION_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('21. Deterministic ledger ID collision fails with LEDGER_ALREADY_EXISTS and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
  db.data.wallet_entries[ledgerId] = { fake: true };
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'LEDGER_ALREADY_EXISTS'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('22. Idempotent duplicate accept returns success with zero additional writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  const res1 = await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_idem' });
  assert.equal(res1.accepted, true);

  const snapshotAfterFirst = captureFullDbSnapshot(db);

  const res2 = await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_idem' });
  assert.equal(res2.accepted, true);
  assert.equal(res2.idempotent, true);

  assert.deepEqual(captureFullDbSnapshot(db), snapshotAfterFirst);
});

test('23. Contradictory partial acceptance fails closed as ACCEPTANCE_CONFLICT with zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  delete db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId];

  const before = captureFullDbSnapshot(db);
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('24. Driver ineligibility checks fail closed with zero writes', async () => {
  // KYC not approved
  {
    const { db, jobId, driverId, offerId, nowMs } = setupSeed({
      driverPatch: { verificationStatus: 'pending' },
    });
    const before = captureFullDbSnapshot(db);
    const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
    await assert.rejects(
      () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
      err => err.code === 'DRIVER_INELIGIBLE'
    );
    assert.deepEqual(captureFullDbSnapshot(db), before);
  }

  // Off duty
  {
    const { db, jobId, driverId, offerId, nowMs } = setupSeed({
      driverPatch: { isOnDuty: false },
    });
    const before = captureFullDbSnapshot(db);
    const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
    await assert.rejects(
      () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
      err => err.code === 'DRIVER_INELIGIBLE'
    );
    assert.deepEqual(captureFullDbSnapshot(db), before);
  }

  // Capability mismatch
  {
    const { db, jobId, driverId, offerId, nowMs } = setupSeed({
      jobPatch: { requestedTruckType: 'flatbed' },
      driverPatch: { canFlatbed: false },
    });
    const before = captureFullDbSnapshot(db);
    const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
    await assert.rejects(
      () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
      err => err.code === 'DRIVER_INELIGIBLE'
    );
    assert.deepEqual(captureFullDbSnapshot(db), before);
  }

  // Active ban
  {
    const nowMs = 1000000;
    const { db, jobId, driverId, offerId } = setupSeed({
      nowMs,
      driverPatch: { bannedUntil: FakeTimestamp.fromMillis(nowMs + 10000) },
    });
    const before = captureFullDbSnapshot(db);
    const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
    await assert.rejects(
      () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
      err => err.code === 'DRIVER_BANNED'
    );
    assert.deepEqual(captureFullDbSnapshot(db), before);
  }
});

// ============================================================================
// SOL SECTION A: DUPLICATE CORRUPTION MATRIX
// ============================================================================

test('A1. Duplicate accept rejects corrupt ledger.balanceAfterPaise with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].balanceAfterPaise = 999999;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A2. Duplicate accept rejects corrupt ledger balanceBefore arithmetic with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].balanceBeforePaise = 30000;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A3. Duplicate accept rejects corrupt ledger sourceType with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceType = 'system';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A4. Duplicate accept rejects missing offer cancellationPolicySnapshot with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot = null;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A5. Duplicate accept rejects malformed policy snapshot with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  delete db.data.job_offers[offerId].cancellationPolicySnapshot.roundingMode;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A6. Duplicate accept rejects non-null run.finalizedAt with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data['jobs/' + jobId + '/dispatch_runs']['1'].finalizedAt = FakeTimestamp.fromMillis(nowMs + 5000);
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A7. Duplicate accept rejects non-null driver.activeOfferId with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.drivers[driverId].activeOfferId = offerId;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A8. Duplicate accept rejects wrong job.dispatchState with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].dispatchState = 'offered';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A9. Duplicate accept rejects uncleared job offered fields with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].offeredTo = driverId;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A10. Duplicate accept rejects invalid accepted stateVersion with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].stateVersion = -1;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A11. Duplicate accept rejects outbox payload with extra key with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].payload.customerPhone = '+919999999999';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A12. Duplicate accept rejects corrupt outbox immutable binding with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].resourceId = 'other_job';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('A13. Legitimate outbox progression (sent/retry) remains idempotent success', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].state = 'sent';
  db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].sentAt = FakeTimestamp.fromMillis(nowMs + 2000);

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
});

test('A14. Outbox lifecycle: all committed states (pending, in_progress, retry_wait, sent, failed_terminal) allow idempotent success; illegal state fails closed', async () => {
  const committedStates = ['pending', 'in_progress', 'retry_wait', 'sent', 'failed_terminal'];
  for (const st of committedStates) {
    const { db, jobId, driverId, offerId, nowMs } = setupSeed();
    const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
    await manager.acceptJob({ jobId, offerId, driverUid: driverId });

    db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].state = st;
    const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
    assert.equal(res.accepted, true);
    assert.equal(res.idempotent, true);
  }

  // Illegal state ('processing') fails closed
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId].state = 'processing';
  const before = captureFullDbSnapshot(db);
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL SECTION B: DRIVER ELIGIBILITY
// ============================================================================

test('B1. bannedUntil string fails closed with DRIVER_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { bannedUntil: '2026-09-02T10:00:00Z' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B2. bannedUntil number fails closed with DRIVER_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { bannedUntil: 1725271200000 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B3. bannedUntil Date fails closed with DRIVER_INVALID and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    driverPatch: { bannedUntil: new Date(nowMs + 100000) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B4. bannedUntil duck object fails closed with DRIVER_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { bannedUntil: { seconds: 12345, nanoseconds: 0 } },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B5. bannedUntil future Timestamp fails with DRIVER_BANNED and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    driverPatch: { bannedUntil: FakeTimestamp.fromMillis(nowMs + 60000) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_BANNED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B6. bannedUntil past Timestamp is eligible and succeeds', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    driverPatch: { bannedUntil: FakeTimestamp.fromMillis(nowMs - 60000) },
  });
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
});

test('B7. Missing requestedTruckType fails with JOB_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  delete db.data.jobs[jobId].requestedTruckType;
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'JOB_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B8. Invalid requestedTruckType ("tochan") fails with JOB_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { requestedTruckType: 'tochan' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'JOB_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B9. Malformed canFlatbed (string) fails closed with DRIVER_INELIGIBLE and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { canFlatbed: 'true' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INELIGIBLE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('B10. Malformed canPulling (null) fails closed with DRIVER_INELIGIBLE and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { canPulling: null },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'DRIVER_INELIGIBLE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL SECTION C: OFFERED OCCURRENCE & TIMING
// ============================================================================

test('C1. Offered job with assignedDriver populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { assignedDriver: 'driver_test_1' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('C2. Offered job with acceptedAt populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: { acceptedAt: FakeTimestamp.fromMillis(nowMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('C3. Offered job with commissionDebitEntryId populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { commissionDebitEntryId: 'commission_debit:job_test_1:offer_test_1' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('C4. Terminal offer evidence in offered state fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    offerPatch: { resolvedAt: FakeTimestamp.fromMillis(nowMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('C5. Forged 90-second lifetime fails with OFFER_EXPIRY_INVALID and 0 writes even before expiry', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.job_offers[offerId].expiresAt = FakeTimestamp.fromMillis(nowMs + 90000);
  db.data.jobs[jobId].offerExpiresAt = FakeTimestamp.fromMillis(nowMs + 90000);
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 10000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'OFFER_EXPIRY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('C6. Exact 45s lifetime: T + 44,999ms may accept, T + 45,000ms cannot accept', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({ offerLifetimeMs: 45000 });
  const managerAcceptable = createAcceptJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 44999),
  });

  const res = await managerAcceptable.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);

  const seed2 = setupSeed({ nowMs: 2000000, offerLifetimeMs: 45000 });
  const managerExpired = createAcceptJobManager({
    db: seed2.db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(2000000 + 45000),
  });
  const before2 = captureFullDbSnapshot(seed2.db);

  await assert.rejects(
    () => managerExpired.acceptJob({ jobId: seed2.jobId, offerId: seed2.offerId, driverUid: seed2.driverId }),
    err => err.code === 'OFFER_EXPIRED'
  );
  assert.deepEqual(captureFullDbSnapshot(seed2.db), before2);
});

// ============================================================================
// SOL SECTION D: CANCELLATION POLICY
// ============================================================================

test('D1. Empty cancellation policy {} fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    configPatch: { cancellation_policy: {} },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D2. Partial ramp {"2": 20} fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count = { '2': 20 };
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D3. Missing interior key (2, 4, 5 missing 3) fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count = { '2': 20, '4': 60, '5': 80 };
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D4. Noncanonical key "02" fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count = { '02': 20, '3': 40, '4': 60, '5': 80 };
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D5. Extra out-of-domain key "6" when B=6 fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count = { '2': 20, '3': 40, '4': 60, '5': 80, '6': 100 };
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D6. Percentage < allowed minimum (-1) fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count['2'] = -1;
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D7. Percentage > allowed maximum (101) fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count['2'] = 101;
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D8. Float percentage (20.5) fails with CANCELLATION_POLICY_INVALID and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy.forfeit_pct_by_count['2'] = 20.5;
  const before = captureFullDbSnapshot(db);
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'CANCELLATION_POLICY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('D9. Future valid configurable policy with F=0, B=4 ("1", "2", "3") succeeds', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy = {
    version: 2,
    timezone: 'Asia/Kolkata',
    roundingMode: 'HALF_UP',
    free_cancellations_per_month: 0,
    forfeit_pct_by_count: {
      '1': 25,
      '2': 50,
      '3': 75,
    },
    ban_threshold_count: 4,
    ban_duration_days: 14,
  };
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  const snapshot = db.data.job_offers[offerId].cancellationPolicySnapshot;
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.freeCancellationsPerMonth, 0);
  assert.deepEqual(snapshot.forfeitPctByCount, { '1': 25, '2': 50, '3': 75 });
});

// ============================================================================
// SOL SECTION E: PROCESSED REQUESTS BINDING
// ============================================================================

test('E1. Retry with wrong payloadHash fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].payloadHash = 'wrong_hash';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E2. Retry with wrong result fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].result = { accepted: false };
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E3. Retry with wrong type fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].type = 'razorpay_webhook';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E4. Retry with in_progress receipt fails closed with 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].status = 'in_progress';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_IN_PROGRESS' || err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E5. Retry with wrong actorUid fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].actorUid = 'other_driver';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E6. Retry with wrong operation fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].operation = 'decline';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E7. Retry with wrong resourceId fails with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' });

  db.data.processed_requests['req_sol_e'].resourceId = jobId + ':other_offer';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_sol_e' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E8. Idempotency: CASE A & CASE B — original acceptance with req-A allows retry with req-A or receiptless retry, preserving historical provenance', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  assert.equal(db.data.job_offers[offerId].acceptRequestId, 'req-A');
  assert.equal(db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId, 'req-A');

  // CASE A: retry with same req-A
  const resA = await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });
  assert.equal(resA.accepted, true);
  assert.equal(resA.idempotent, true);

  // CASE B: receiptless retry (no requestId)
  const resB = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(resB.accepted, true);
  assert.equal(resB.idempotent, true);
  // Provenance must NOT be cleared or set to null
  assert.equal(db.data.job_offers[offerId].acceptRequestId, 'req-A');
  assert.equal(db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId, 'req-A');
});

test('E9. Idempotency: CASE C — original acceptance without requestId allows retry without requestId', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  assert.equal(db.data.job_offers[offerId].acceptRequestId, null);
  assert.equal(db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId, null);

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
  assert.equal(db.data.job_offers[offerId].acceptRequestId, null);
  assert.equal(db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId, null);
});

test('E10. Idempotency: CASE D — original acceptance with req-A allows retry with different req-B without mutating historical provenance', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  // Retry with req-B where no req-B receipt exists
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-B' });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);

  // Historical provenance must remain req-A
  assert.equal(db.data.job_offers[offerId].acceptRequestId, 'req-A');
  assert.equal(db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId, 'req-A');
  assert.equal(db.data.processed_requests['req-B'], undefined);
});

test('E11. Contradictory provenance between offer.acceptRequestId and ledger.sourceRequestId fails closed with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId = 'req-CONFLICT';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('E12. Missing ledger sourceRequestId when offer.acceptRequestId is populated fails closed with ACCEPTANCE_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId].sourceRequestId = null;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL BLOCKER 1: CANONICAL VALIDATION OF STORED POLICY SNAPSHOT
// ============================================================================

test('F1. Duplicate accept rejects stored policy snapshot with empty ramp {}', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.forfeitPctByCount = {};
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F2. Duplicate accept rejects stored policy snapshot with missing interior ramp key', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  // Missing "3" in ramp 2, 4, 5
  db.data.job_offers[offerId].cancellationPolicySnapshot.forfeitPctByCount = {
    '2': 20,
    '4': 60,
    '5': 80,
  };
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F3. Duplicate accept rejects stored policy snapshot with noncanonical ramp key "02"', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.forfeitPctByCount = {
    '02': 20,
    '3': 40,
    '4': 60,
    '5': 80,
  };
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F4. Duplicate accept rejects stored policy snapshot with string percentage', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.forfeitPctByCount['2'] = '20';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F5. Duplicate accept rejects stored policy snapshot with percentage 101', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.forfeitPctByCount['2'] = 101;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F6. Duplicate accept rejects stored policy snapshot with banThresholdCount <= F + 1', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.freeCancellationsPerMonth = 1;
  db.data.job_offers[offerId].cancellationPolicySnapshot.banThresholdCount = 1;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F7. Duplicate accept rejects stored policy snapshot with malformed capturedAt', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.job_offers[offerId].cancellationPolicySnapshot.capturedAt = new Date().toISOString();
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('F8. Duplicate accept succeeds canonically for valid future F=0, B=4 stored snapshot', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.pricing_config.main.cancellation_policy = {
    version: 2,
    timezone: 'Asia/Kolkata',
    roundingMode: 'HALF_UP',
    free_cancellations_per_month: 0,
    forfeit_pct_by_count: {
      '1': 25,
      '2': 50,
      '3': 75,
    },
    ban_threshold_count: 4,
    ban_duration_days: 14,
  };
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
});

// ============================================================================
// SOL BLOCKER 2: HISTORICAL ORIGINAL RECEIPT VERIFICATION
// ============================================================================

test('G1. Original req-A -> delete req-A receipt -> retry req-A fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  delete db.data.processed_requests['req-A'];
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('G2. Original req-A -> delete req-A receipt -> retry without ID fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  delete db.data.processed_requests['req-A'];
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('G3. Original req-A -> corrupt req-A hash -> retry without ID fails closed with REQUEST_BINDING_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  db.data.processed_requests['req-A'].payloadHash = 'corrupted_hash';
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('G4. Original req-A -> canonical receipt -> retry without ID succeeds idempotently', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  const before = captureFullDbSnapshot(db);
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('G5. Original req-A -> canonical historical receipt -> retry req-B no req-B doc succeeds, no fabricated receipt', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-A' });

  const before = captureFullDbSnapshot(db);
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-B' });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
  assert.equal(db.data.processed_requests['req-B'], undefined);
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('G6. Original no requestId -> retry no requestId succeeds idempotently', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  const before = captureFullDbSnapshot(db);
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL BLOCKER 3: COMPLETE CLEAN JOB LIFECYCLE BEFORE ACCEPTANCE
// ============================================================================

test('H1. Offered job with inProgressAt populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].inProgressAt = FakeTimestamp.fromMillis(nowMs);
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('H2. Offered job with completedAt populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].completedAt = FakeTimestamp.fromMillis(nowMs);
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('H3. Offered job with cancellationResolvedAt populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].cancellationResolvedAt = FakeTimestamp.fromMillis(nowMs);
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT' || err.code === 'CANCELLATION_PROVENANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('H4. Offered job with refundRequestId populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundRequestId = jobId;
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('H5. Offered job with refundState pending fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundState = 'pending';
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('H6. Offered job with razorpayRefundId populated fails with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].razorpayRefundId = 'rfnd_fake_123';
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL BLOCKER 4: MAX_SAFE_INTEGER STATEVERSION DUPLICATE ACCEPTANCE
// ============================================================================

test('I1. Offered stateVersion = MAX_SAFE_INTEGER - 1 accepts cleanly and sets stateVersion = MAX_SAFE_INTEGER', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].stateVersion = Number.MAX_SAFE_INTEGER - 1;

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(db.data.jobs[jobId].stateVersion, Number.MAX_SAFE_INTEGER);
});

test('I2. Immediate duplicate acceptance with stateVersion = MAX_SAFE_INTEGER succeeds with ZERO writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].stateVersion = Number.MAX_SAFE_INTEGER - 1;

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(db.data.jobs[jobId].stateVersion, Number.MAX_SAFE_INTEGER);

  const before = captureFullDbSnapshot(db);
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(res.idempotent, true);
  assert.equal(db.data.jobs[jobId].stateVersion, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('I3. Duplicate accept with negative stateVersion fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].stateVersion = -1;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('I4. Duplicate accept with float stateVersion fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].stateVersion = 2.5;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('I5. Duplicate accept with unsafe integer stateVersion fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await manager.acceptJob({ jobId, offerId, driverUid: driverId });

  db.data.jobs[jobId].stateVersion = 9007199254740992;
  const before = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// SOL BLOCKER REPAIR: REFUNDED AMOUNT PAISE CLEAN OFFERED GUARD
// ============================================================================

test('J1. Canonical offered state with refundedAmountPaise = null succeeds', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundedAmountPaise = null;

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(db.data.jobs[jobId].assignedDriver, driverId);
  assert.equal(db.data.jobs[jobId].status, 'accepted');
});

test('J2. Legacy-compatible omitted refundedAmountPaise succeeds', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  delete db.data.jobs[jobId].refundedAmountPaise;

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(db.data.jobs[jobId].assignedDriver, driverId);
  assert.equal(db.data.jobs[jobId].status, 'accepted');
});

test('J3. Offered job with refundedAmountPaise = 10000 fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundedAmountPaise = 10000;
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('J4. Offered job with refundedAmountPaise = 0 fails closed with ACCEPTANCE_CONFLICT and 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundedAmountPaise = 0;
  const before = captureFullDbSnapshot(db);

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('J5. Legitimate pre-acceptance forfeitedAmount remains accepted when schema permits it', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  db.data.jobs[jobId].refundedAmountPaise = null;
  db.data.jobs[jobId].forfeitedAmount = 2000;

  const manager = createAcceptJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });
  const res = await manager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(res.accepted, true);
  assert.equal(db.data.jobs[jobId].status, 'accepted');
  assert.equal(db.data.jobs[jobId].forfeitedAmount, 2000);
});


