'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { GeoPoint } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createDeclineJobManager,
  getDefaultDeclineJobManager,
  createDeclineJobCallable,
  declineJob,
} = require('../../../firebase/functions/src/dispatch/declineJob');
const { POLICY_KEYS, DispatchError } = require('../../../firebase/functions/src/dispatch/dispatchValidation');
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
    monthlyCancelCount: 1,
    strictMode: false,
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
    }, {
      driverId: 'driver_test_2',
      roundIndex: 0,
      haversineDistanceKm: 4.5,
      matrixEtaSeconds: 700,
      matrixDistanceMeters: 6000,
      rankingMode: 'ola',
      outcome: 'pending',
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
        forfeit_pct_by_count: { '2': 20, '3': 40, '4': 60, '5': 80 },
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
// BASELINE TESTS 1 - 34+
// ============================================================================

test('1. Valid decline: atomic job, offer, run, driver, and receipt mutation', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  let cascadeCalled = false;
  let cascadeJobId = null;
  const dispatchService = {
    processDispatchJob: async id => {
      cascadeCalled = true;
      cascadeJobId = id;
      return { dispatched: true };
    },
  };

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
    dispatchService,
  });

  const res = await manager.declineJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req_dec_1',
  });

  assert.equal(res.declined, true);
  assert.equal(res.jobId, jobId);
  assert.equal(res.offerId, offerId);
  assert.equal(res.driverId, driverId);
  assert.equal(res.candidateIndex, 0);

  // Job checks: reset to pending_offer / ready
  const updatedJob = db.data.jobs[jobId];
  assert.equal(updatedJob.status, 'pending_offer');
  assert.equal(updatedJob.dispatchState, 'ready');
  assert.equal(updatedJob.offeredTo, null);
  assert.equal(updatedJob.currentOfferId, null);
  assert.equal(updatedJob.offeredAt, null);
  assert.equal(updatedJob.offerExpiresAt, null);
  assert.equal(updatedJob.dispatchLeaseOwner, null);
  assert.equal(updatedJob.dispatchLeaseUntil, null);
  assert.ok(updatedJob.dispatchNextActionAt);
  assert.equal(updatedJob.dispatchLastFailure, null);
  assert.equal(updatedJob.stateVersion, 2);

  // Offer checks: offered -> declined
  const updatedOffer = db.data.job_offers[offerId];
  assert.equal(updatedOffer.status, 'declined');
  assert.ok(updatedOffer.resolvedAt);
  assert.equal(updatedOffer.resolutionReason, 'declined_by_driver');

  // Run checks: candidate outcome -> declined, currentOfferId -> null, nextCandidateIndex preserved
  const updatedRun = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.equal(updatedRun.status, 'active');
  assert.equal(updatedRun.currentOfferId, null);
  assert.equal(updatedRun.candidates[0].outcome, 'declined');
  assert.equal(updatedRun.candidates[0].reasonCode, null);
  assert.equal(updatedRun.nextCandidateIndex, 1);
  assert.deepEqual(updatedRun.attemptedDriverIds, [driverId]);
  assert.deepEqual(updatedRun.excludedDriverIds, []);

  // Driver checks: activeOfferId cleared, activeJobId remains null
  const updatedDriver = db.data.drivers[driverId];
  assert.equal(updatedDriver.activeOfferId, null);
  assert.equal(updatedDriver.activeJobId, null);

  // Receipt checks
  const receipt = db.data.processed_requests['req_dec_1'];
  assert.ok(receipt);
  assert.equal(receipt.requestId, 'req_dec_1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.type, 'phase4_client_mutation');
  assert.equal(receipt.actorUid, driverId);
  assert.equal(receipt.operation, 'decline');
  assert.equal(receipt.resourceId, jobId + ':' + offerId);
  assert.equal(receipt.ownerToken, null);
  assert.equal(receipt.leaseUntil, null);
  assert.ok(receipt.claimedAt);
  assert.ok(receipt.processedAt);
  assert.deepEqual(receipt.result, {
    declined: true,
    jobId,
    offerId,
    driverId,
  });

  // Post-commit cascade kick invoked
  assert.equal(cascadeCalled, true);
  assert.equal(cascadeJobId, jobId);
});

test('2. Unauthenticated driver throws unauthenticated HttpsError', async () => {
  const { db } = setupSeed();
  const manager = createDeclineJobManager({ db });
  const callable = createDeclineJobCallable({ declineJobManager: manager });

  await assert.rejects(
    () => callable.run({ data: { jobId: 'j1', offerId: 'o1', requestId: 'r1' }, auth: null }),
    err => err.code === 'unauthenticated'
  );
});

test('3. Missing/invalid requestId throws INVALID_ARGUMENT (invalid-argument)', async () => {
  const { db, jobId, driverId, offerId } = setupSeed();
  const manager = createDeclineJobManager({ db });
  const callable = createDeclineJobCallable({ declineJobManager: manager });

  // Missing requestId
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: undefined }),
    err => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => callable.run({ data: { jobId, offerId }, auth: { uid: driverId } }),
    err => err.code === 'invalid-argument'
  );

  // Empty requestId
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: '' }),
    err => err.code === 'INVALID_ARGUMENT'
  );

  // Slash in requestId
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'bad/id' }),
    err => err.code === 'INVALID_ARGUMENT'
  );
});

test('4. Wrong driver UID fails with WRONG_DRIVER and zero writes', async () => {
  const { db, jobId, offerId, nowMs } = setupSeed();
  db.data.drivers['driver_wrong'] = cloneDb(db.data.drivers['driver_test_1']);
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: 'driver_wrong', requestId: 'req_1' }),
    err => err.code === 'WRONG_DRIVER'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('5. Wrong job/offer binding fails with OFFER_BINDING_MISMATCH and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { jobId: 'other_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_BINDING_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('6. Wrong generation fails with OFFER_GENERATION_MISMATCH and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { dispatchGeneration: 2 },
  });
  db.data['jobs/' + jobId + '/dispatch_runs']['2'] = cloneDb(db.data['jobs/' + jobId + '/dispatch_runs']['1']);
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('7. Malformed run fails with RUN_INVALID and zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    runPatch: { finalizedAt: FakeTimestamp.fromMillis(nowMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('8. Candidate mismatch fails with CANDIDATE_DRIVER_MISMATCH and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    runPatch: {
      candidates: [{
        driverId: 'different_driver',
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'offered',
        reasonCode: null,
      }],
      attemptedDriverIds: ['different_driver'],
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'CANDIDATE_DRIVER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('9. Candidate outcome not offered fails with CANDIDATE_OUTCOME_CONFLICT and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    runPatch: {
      candidates: [{
        driverId: 'driver_test_1',
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'declined',
        reasonCode: null,
      }],
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'CANDIDATE_OUTCOME_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('10. Active offer mismatch fails with DRIVER_ENGAGEMENT_MISMATCH and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    driverPatch: { activeOfferId: 'different_offer' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('11. Customer cancellation precedence fails closed with CANCELLATION_PRECEDENCE and zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs + 500),
      cancellationResolutionState: 'pending',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('12. Malformed cancellation provenance fails closed with CANCELLATION_PROVENANCE_CONFLICT and zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: {
      cancelledBy: 'unexpected_party',
      cancellationResolutionState: 'none',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'CANCELLATION_PROVENANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('13. Exact expiry boundary fails with OFFER_EXPIRED and zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId, expiresAt } = setupSeed({ nowMs });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiresAt.toMillis()), // exactly at expiry instant
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_EXPIRED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('14. Forged non-45s lifetime fails with OFFER_EXPIRY_INVALID and zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    offerLifetimeMs: 90000,
    jobPatch: { offerExpiresAt: FakeTimestamp.fromMillis(nowMs + 90000) },
    offerPatch: { expiresAt: FakeTimestamp.fromMillis(nowMs + 90000) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_EXPIRY_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('15. stateVersion overflow (MAX_SAFE_INTEGER) fails with JOB_STATE_VERSION_INVALID and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('16. Candidate cursor preserved: nextCandidateIndex remains unchanged after decline', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const run = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.equal(run.nextCandidateIndex, 1); // was 1 at offer time, still 1 after decline
});

test('17. Attempted history preserved after decline', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const run = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.deepEqual(run.attemptedDriverIds, [driverId]);
});

test('18. excludedDriverIds preserved (not added) after decline', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const run = db.data['jobs/' + jobId + '/dispatch_runs']['1'];
  assert.deepEqual(run.excludedDriverIds, []);
});

test('19. No wallet mutation (walletBalance unchanged)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.walletBalance, 25000);
});

test('20. No monthlyCancelCount mutation', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.monthlyCancelCount, 1);
});

test('21. No strictMode mutation', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.strictMode, false);
});

test('22. No bannedUntil mutation', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.bannedUntil, null);
});

test('23. No wallet ledger created (wallet_entries empty)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  assert.deepEqual(db.data.wallet_entries, {});
});

test('24. No decline outbox created (notification_outbox empty)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' });

  assert.deepEqual(db.data.notification_outbox, {});
});

test('25. Canonical processed_requests receipt has exact schema fields, types, and payloadHash', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_canonical_1' });

  const receipt = db.data.processed_requests['req_canonical_1'];
  assert.ok(receipt);
  assert.equal(receipt.requestId, 'req_canonical_1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.type, 'phase4_client_mutation');
  assert.equal(receipt.actorUid, driverId);
  assert.equal(receipt.operation, 'decline');
  assert.equal(receipt.resourceId, jobId + ':' + offerId);
  assert.equal(receipt.ownerToken, null);
  assert.equal(receipt.leaseUntil, null);
  assert.ok(receipt.claimedAt);
  assert.ok(receipt.processedAt);

  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  assert.equal(receipt.payloadHash, expectedHash);

  assert.deepEqual(receipt.result, {
    declined: true,
    jobId,
    offerId,
    driverId,
  });
});

test('26. Same request retry idempotency after job has already cascaded forward', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  // First call succeeds and creates receipt
  const res1 = await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_retry_1' });
  assert.equal(res1.declined, true);

  // Simulate dispatch cascade: job advances to another driver (driver_test_2)
  db.data.jobs[jobId].status = 'offered';
  db.data.jobs[jobId].dispatchState = 'offered';
  db.data.jobs[jobId].offeredTo = 'driver_test_2';
  db.data.jobs[jobId].currentOfferId = 'offer_test_2';
  db.data.jobs[jobId].stateVersion = 3;

  const snapBeforeRetry = captureFullDbSnapshot(db);

  // Retry with SAME requestId returns canonical idempotent success without reverting the job!
  const res2 = await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_retry_1' });
  assert.equal(res2.declined, true);
  assert.equal(res2.idempotent, true);
  assert.equal(res2.jobId, jobId);
  assert.equal(res2.offerId, offerId);
  assert.equal(res2.driverId, driverId);

  // Assert ZERO writes during retry
  assert.deepEqual(captureFullDbSnapshot(db), snapBeforeRetry);
});

test('27. Wrong receipt actor fails with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_conflict'] = {
    requestId: 'req_conflict',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: 'different_actor',
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_conflict' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('28. Wrong receipt resource fails with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_conflict'] = {
    requestId: 'req_conflict',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: 'wrong_job:wrong_offer',
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_conflict' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('29. Wrong receipt hash fails with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);

  db.data.processed_requests['req_conflict'] = {
    requestId: 'req_conflict',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash: 'bad_hash_value',
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_conflict' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('30. Wrong receipt result/status/type fails with REQUEST_BINDING_CONFLICT and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  // Wrong status (e.g. pending or unknown)
  db.data.processed_requests['req_status'] = {
    requestId: 'req_status',
    status: 'unknown_status',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };

  // In progress status throws REQUEST_IN_PROGRESS
  db.data.processed_requests['req_progress'] = {
    requestId: 'req_progress',
    status: 'in_progress',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };

  // Wrong type
  db.data.processed_requests['req_type'] = {
    requestId: 'req_type',
    status: 'completed',
    type: 'wrong_type',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };

  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_status' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_progress' }),
    err => err.code === 'REQUEST_IN_PROGRESS'
  );
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_type' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );

  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('31. Already accepted offer cannot decline (OFFER_NOT_ACTIVE)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { status: 'accepted' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_NOT_ACTIVE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('32. Already expired offer cannot decline (OFFER_NOT_ACTIVE)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    offerPatch: { status: 'expired' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_NOT_ACTIVE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('33. Stale previous generation cannot decline (OFFER_GENERATION_MISMATCH)', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed({
    jobPatch: { dispatchGeneration: 2, dispatchRunId: '2' },
    offerPatch: { dispatchGeneration: 1 },
  });
  db.data['jobs/' + jobId + '/dispatch_runs']['2'] = cloneDb(db.data['jobs/' + jobId + '/dispatch_runs']['1']);
  db.data['jobs/' + jobId + '/dispatch_runs']['2'].generation = 2;
  const before = captureFullDbSnapshot(db);

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    err => err.code === 'OFFER_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('34. Complete zero-write corruption assertions across negative cases', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupSeed({
    nowMs,
    jobPatch: {
      acceptedAt: FakeTimestamp.fromMillis(nowMs), // corruption marker
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_corrupt' }),
    err => err.code === 'DECLINE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// REQUIRED CORRECTION TESTS (User Review Points 1-4)
// ============================================================================

test('35. Full canonical receipt validation: non-null ownerToken fails with REQUEST_BINDING_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_corrupt_owner'] = {
    requestId: 'req_corrupt_owner',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: 'invalid_non_null_token',
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_corrupt_owner' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('36. Full canonical receipt validation: invalid claimedAt timestamp fails with REQUEST_BINDING_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_corrupt_claimedAt'] = {
    requestId: 'req_corrupt_claimedAt',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: 'not_a_timestamp',
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_corrupt_claimedAt' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('37. Full canonical receipt validation: non-null leaseUntil fails with REQUEST_BINDING_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_corrupt_lease'] = {
    requestId: 'req_corrupt_lease',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: at,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_corrupt_lease' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('38. Full canonical receipt validation: invalid processedAt timestamp fails with REQUEST_BINDING_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  db.data.processed_requests['req_corrupt_processedAt'] = {
    requestId: 'req_corrupt_processedAt',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: null,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
  };
  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_corrupt_processedAt' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('39. Full canonical receipt validation: missing/extra fields in receipt or result map fail with REQUEST_BINDING_CONFLICT', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const at = FakeTimestamp.fromMillis(nowMs);
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');

  // Extra field in receipt
  db.data.processed_requests['req_extra_receipt'] = {
    requestId: 'req_extra_receipt',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId },
    extraField: 'unexpected',
  };

  // Extra field in result
  db.data.processed_requests['req_extra_result'] = {
    requestId: 'req_extra_result',
    status: 'completed',
    type: 'phase4_client_mutation',
    ownerToken: null,
    claimedAt: at,
    leaseUntil: null,
    processedAt: at,
    actorUid: driverId,
    operation: 'decline',
    resourceId: jobId + ':' + offerId,
    payloadHash,
    result: { declined: true, jobId, offerId, driverId, extra: true },
  };

  const before = captureFullDbSnapshot(db);
  const manager = createDeclineJobManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(nowMs + 1000) });

  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_extra_receipt' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_extra_result' }),
    err => err.code === 'REQUEST_BINDING_CONFLICT'
  );

  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('40. Post-commit cascade failure: injected processDispatchJob throws but caller still receives decline success', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const dispatchService = {
    processDispatchJob: async () => {
      throw new Error('Injected network timeout in dispatch acceleration');
    },
  };

  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
    dispatchService,
  });

  // Call declineJob: transaction commits, dispatchService throws, but caller receives success!
  const res = await manager.declineJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req_cascade_err_1',
  });

  assert.equal(res.declined, true);
  assert.equal(res.jobId, jobId);
  assert.equal(res.offerId, offerId);
  assert.equal(res.driverId, driverId);

  // Assert domain mutation is fully committed in database
  const job = db.data.jobs[jobId];
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');

  const offer = db.data.job_offers[offerId];
  assert.equal(offer.status, 'declined');

  const receipt = db.data.processed_requests['req_cascade_err_1'];
  assert.ok(receipt);
  assert.equal(receipt.status, 'completed');
});

test('41. Different requestId against already-declined offer fails with OFFER_NOT_ACTIVE and zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupSeed();
  const manager = createDeclineJobManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  // First request declines the offer
  const res1 = await manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_first' });
  assert.equal(res1.declined, true);

  const snapshotAfterFirst = captureFullDbSnapshot(db);

  // Different requestId against the already-declined offer
  await assert.rejects(
    () => manager.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req_different' }),
    err => err.code === 'OFFER_NOT_ACTIVE'
  );

  // Assert ZERO writes: no second receipt created, no domain state altered
  assert.deepEqual(captureFullDbSnapshot(db), snapshotAfterFirst);
  assert.equal(db.data.processed_requests['req_different'], undefined);
});
