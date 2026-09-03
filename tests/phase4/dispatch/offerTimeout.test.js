'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createOfferTimeoutManager,
  getDefaultTimeoutManager,
  offerTimeout,
} = require('../../../firebase/functions/src/dispatch/offerTimeout');
const { POLICY_KEYS } = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const { paidJob, driver, config } = require('../fixtures');

function setupSeed({ nowMs = 1000000, offerLifetimeMs = 45000, jobPatch = {}, offerPatch = {}, driverPatch = {}, runPatch = {} } = {}) {
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
    driverCommissionPaise: 50000,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    ...offerPatch,
  };

  const fullConfig = config(FakeTimestamp, nowMs);
  const policySnapshot = Object.fromEntries(POLICY_KEYS.map(key => [key, fullConfig[key]]));

  const run = {
    jobId,
    generation,
    status: 'active',
    policyVersion: 1,
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
    attemptedDriverIds: [driverId],
    excludedDriverIds: [],
    currentOfferId: offerId,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    finalizedAt: null,
    ...runPatch,
  };

  const db = new FakeFirestore();
  db.seed('jobs', jobId, job);
  db.seed('drivers', driverId, driverDoc);
  db.seed('job_offers', offerId, offer);
  db.seed(`jobs/${jobId}/dispatch_runs`, String(generation), run);

  return { db, jobId, driverId, offerId, generation, nowMs, offerLifetimeMs };
}

test('Blocker 1: production exported offerTimeout initializes and handles tasks correctly', async () => {
  // 1. Exported getDefaultTimeoutManager initializes cleanly without throwing TypeError
  const defaultManager = getDefaultTimeoutManager();
  assert.ok(defaultManager);
  assert.equal(typeof defaultManager.expireOfferTimeout, 'function');
  assert.equal(typeof defaultManager.handleOfferTimeoutTask, 'function');

  // 2. Exported onTaskDispatched function is a valid function with run/handle capability
  assert.ok(offerTimeout);
  assert.equal(typeof offerTimeout.run, 'function');

  // 3. Test handleOfferTimeoutTask through default manager with fake db
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });

  let currentClock = expiryTime + 100;
  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(currentClock),
  });

  // Due task reaches expiration domain logic
  const result = await manager.handleOfferTimeoutTask({ data: { jobId, offerId, dispatchGeneration: generation } });
  assert.equal(result.expired, true);
  assert.equal(result.offerId, offerId);

  // Stale task reaches safe no-op
  const staleResult = await manager.handleOfferTimeoutTask({ data: { jobId, offerId, dispatchGeneration: generation } });
  assert.equal(staleResult.expired, false);
  assert.equal(staleResult.reason, 'OFFER_NOT_ACTIVE');

  // Early task reaches retry path (throws Error('OFFER_NOT_EXPIRED'))
  const { db: earlyDb, jobId: earlyJob, offerId: earlyOffer, generation: earlyGen } = setupSeed({ nowMs: baseTime });
  const earlyManager = createOfferTimeoutManager({
    db: earlyDb,
    TimestampClass: FakeTimestamp,
    now: () => new Date(baseTime + 10000), // 10s into 45s offer
  });
  await assert.rejects(
    () => earlyManager.handleOfferTimeoutTask({ data: { jobId: earlyJob, offerId: earlyOffer, dispatchGeneration: earlyGen } }),
    /OFFER_NOT_EXPIRED/
  );
});

test('offerTimeout: exact 45-second expiry boundary enforcement (0ms grace)', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // 1. Exactly 1ms early -> MUST NOT expire
  {
    const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });
    let currentTime = expiryTime - 1;
    const manager = createOfferTimeoutManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => new Date(currentTime),
    });

    const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
    assert.equal(result.expired, false);
    assert.equal(result.early, true);
    assert.equal(result.reason, 'OFFER_NOT_EXPIRED');

    assert.equal(db.read('job_offers', offerId).status, 'offered');
    assert.equal(db.read('jobs', jobId).status, 'offered');
  }

  // 2. Exactly at expiryTime -> expires
  {
    const { db, jobId, offerId, generation, driverId } = setupSeed({ nowMs: baseTime });
    let currentTime = expiryTime;
    const manager = createOfferTimeoutManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => new Date(currentTime),
    });

    const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
    assert.equal(result.expired, true);
    assert.equal(result.offerId, offerId);
    assert.equal(result.driverId, driverId);

    assert.equal(db.read('job_offers', offerId).status, 'expired');
    assert.equal(db.read('job_offers', offerId).resolutionReason, 'offer_expired');
    assert.equal(db.read('drivers', driverId).activeOfferId, null);
    assert.equal(db.read('jobs', jobId).status, 'pending_offer');
    assert.equal(db.read('jobs', jobId).dispatchState, 'ready');
  }

  // 3. 1ms after expiryTime -> expires
  {
    const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });
    let currentTime = expiryTime + 1;
    const manager = createOfferTimeoutManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => new Date(currentTime),
    });

    const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
    assert.equal(result.expired, true);
    assert.equal(db.read('job_offers', offerId).status, 'expired');
  }
});

test('offerTimeout: atomic expiration updates all documents and preserves cursor & history', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation, driverId } = setupSeed({ nowMs: baseTime });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 500),
  });

  const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
  assert.equal(result.expired, true);

  const job = db.read('jobs', jobId);
  const offer = db.read('job_offers', offerId);
  const driverDoc = db.read('drivers', driverId);
  const run = db.read(`jobs/${jobId}/dispatch_runs`, String(generation));

  // Job assertions
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');
  assert.equal(job.offeredTo, null);
  assert.equal(job.currentOfferId, null);
  assert.equal(job.offeredAt, null);
  assert.equal(job.offerExpiresAt, null);
  assert.equal(job.dispatchLeaseOwner, null);
  assert.equal(job.dispatchLeaseUntil, null);
  assert.equal(job.stateVersion, 2); // Incremented from 1
  assert.equal(job.dispatchGeneration, generation);
  assert.equal(job.dispatchRunId, '1');

  // Offer assertions
  assert.equal(offer.status, 'expired');
  assert.equal(offer.resolutionReason, 'offer_expired');
  assert.equal(offer.resolvedAt.toMillis(), expiryTime + 500);

  // Driver assertions
  assert.equal(driverDoc.activeOfferId, null);

  // Run assertions
  assert.equal(run.status, 'active');
  assert.equal(run.finalizedAt, null);
  assert.equal(run.currentOfferId, null);
  assert.equal(run.nextCandidateIndex, 1); // Strictly PRESERVED
  assert.deepEqual(run.attemptedDriverIds, [driverId]); // Strictly PRESERVED
  assert.equal(run.candidates[0].outcome, 'expired');
});

test('offerTimeout: stale / duplicate invocation no-ops safely when offer is already resolved', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  // First expiration succeeds
  const res1 = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
  assert.equal(res1.expired, true);

  // Second duplicate expiration attempt cleanly no-ops
  const res2 = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
  assert.equal(res2.expired, false);
  assert.equal(res2.reason, 'OFFER_NOT_ACTIVE');
});

test('offerTimeout: respects customer cancellation precedence without mutating state', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });

  // Legitimate customer cancellation marker set on job
  db.data.jobs[jobId].cancellationRequestedAt = FakeTimestamp.fromMillis(baseTime + 10000);
  db.data.jobs[jobId].cancellationResolutionState = 'pending';

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
  assert.equal(result.expired, false);
  assert.equal(result.reason, 'CANCELLATION_PRECEDENCE');

  assert.equal(db.read('jobs', jobId).status, 'offered');
  assert.equal(db.read('jobs', jobId).cancellationResolutionState, 'pending');
});

test('Blocker 2 Unit: fails closed on contradictory cancellation provenance', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // cancellationResolvedAt is non-null while cancellationRequestedAt is null
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    jobPatch: {
      cancellationRequestedAt: null,
      cancellationResolutionState: 'none',
      cancellationResolvedAt: FakeTimestamp.fromMillis(baseTime + 5000),
    },
  });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'CANCELLATION_PROVENANCE_CONFLICT' }
  );

  // Zero writes
  assert.equal(db.read('jobs', jobId).status, 'offered');
  assert.equal(db.read('job_offers', offerId).status, 'offered');
});

test('Blocker 2 Unit: fails closed on job.offeredTo mismatch', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    jobPatch: { offeredTo: 'different_driver_999' },
  });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'JOB_OFFER_MISMATCH' }
  );
  assert.equal(db.read('job_offers', offerId).status, 'offered');
});

test('Blocker 2 Unit: fails closed on candidate outcome conflict (e.g. accepted)', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    runPatch: {
      candidates: [{
        driverId: 'driver_test_1',
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'accepted', // Contradicts active offered state
        reasonCode: null,
      }],
    },
  });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'CANDIDATE_OUTCOME_CONFLICT' }
  );
  assert.equal(db.read('job_offers', offerId).status, 'offered');
});

test('Blocker 2 Unit: fails closed on nested run internal generation mismatch', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    runPatch: { generation: 2 }, // Run stored at path '1' has internal generation 2
  });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'RUN_GENERATION_MISMATCH' }
  );
  assert.equal(db.read('job_offers', offerId).status, 'offered');
});

test('Blocker 2 Unit: fails closed on non-integer stateVersion (e.g. string "1")', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    jobPatch: { stateVersion: '1' }, // String stateVersion
  });

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(expiryTime + 1000),
  });

  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'JOB_STATE_VERSION_INVALID' }
  );
  assert.equal(db.read('job_offers', offerId).status, 'offered');
});

test('convergeTaskMarker: safely converges marker for pending offer and no-ops when already resolved', async () => {
  const baseTime = 1000000;
  const { db, jobId, offerId, generation } = setupSeed({ nowMs: baseTime });
  const taskId = 'task_timeout_sample_123';

  const manager = createOfferTimeoutManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(baseTime + 100),
  });

  // Active pending offer converges
  const res1 = await manager.convergeTaskMarker({ jobId, offerId, dispatchGeneration: generation, taskId });
  assert.equal(res1.converged, true);
  assert.equal(db.read('job_offers', offerId).timeoutTaskState, 'enqueued');
  assert.equal(db.read('job_offers', offerId).timeoutTaskId, taskId);

  // Subsequent convergence call with same or different task ID no-ops (already enqueued)
  const res2 = await manager.convergeTaskMarker({ jobId, offerId, dispatchGeneration: generation, taskId });
  assert.equal(res2.converged, false);
  assert.equal(res2.reason, 'OFFER_NOT_PENDING_ENQUEUE');

  // If offer is resolved (e.g. expired), marker convergence does not regress state
  db.data.job_offers[offerId].status = 'expired';
  db.data.job_offers[offerId].timeoutTaskState = 'pending';
  db.data.job_offers[offerId].timeoutTaskId = null;

  const res3 = await manager.convergeTaskMarker({ jobId, offerId, dispatchGeneration: generation, taskId });
  assert.equal(res3.converged, false);
  assert.equal(res3.reason, 'OFFER_NOT_PENDING_ENQUEUE');
  assert.equal(db.read('job_offers', offerId).status, 'expired');
});

test('LOW P3: stateVersion MAX_SAFE_INTEGER boundary handling', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // 1. MAX_SAFE_INTEGER - 1 legally increments to MAX_SAFE_INTEGER
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER - 1 },
    });
    const manager = createOfferTimeoutManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => new Date(expiryTime + 1000),
    });
    const res = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });
    assert.equal(res.expired, true);
    assert.equal(db.read('jobs', jobId).stateVersion, Number.MAX_SAFE_INTEGER);
  }

  // 2. MAX_SAFE_INTEGER fails closed with zero writes
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
    });
    const manager = createOfferTimeoutManager({
      db,
      TimestampClass: FakeTimestamp,
      now: () => new Date(expiryTime + 1000),
    });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'JOB_STATE_VERSION_INVALID' }
    );
    assert.equal(db.read('jobs', jobId).stateVersion, Number.MAX_SAFE_INTEGER);
    assert.equal(db.read('jobs', jobId).status, 'offered');
    assert.equal(db.read('job_offers', offerId).status, 'offered');
  }
});

test('P1 Unit: nextCandidateIndex skips ahead or falls behind fails closed with RUN_CURSOR_INVALID', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // 1. Skips ahead: candidateIndex = 0, nextCandidateIndex = 2
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      runPatch: {
        candidates: [
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
          { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'pending', reasonCode: null },
        ],
        nextCandidateIndex: 2, // SKIPS AHEAD
        attemptedDriverIds: ['driver_test_1'],
      },
    });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_CURSOR_INVALID' }
    );
    assert.equal(db.read('jobs', jobId).status, 'offered');
    assert.equal(db.read('job_offers', offerId).status, 'offered');
  }

  // 2. Falls behind: candidateIndex = 1, nextCandidateIndex = 1
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      offerPatch: { candidateIndex: 1, driverId: 'driver_test_2' },
      jobPatch: { offeredTo: 'driver_test_2' },
      runPatch: {
        candidates: [
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'expired', reasonCode: null },
          { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
        ],
        nextCandidateIndex: 1, // BEHIND legal position 2
        attemptedDriverIds: ['driver_test_1', 'driver_test_2'],
      },
    });
    db.seed('drivers', 'driver_test_2', { ...db.read('drivers', 'driver_test_1'), activeOfferId: offerId });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_CURSOR_INVALID' }
    );
    assert.equal(db.read('jobs', jobId).status, 'offered');
  }
});

test('P1 Unit: duplicate candidate driver identity or duplicate attemptedDriverIds fails closed', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // Duplicate candidate driver identity in candidates array
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      runPatch: {
        candidates: [
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'pending', reasonCode: null },
        ],
        nextCandidateIndex: 1,
        attemptedDriverIds: ['driver_test_1'],
      },
    });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_INVALID' }
    );
  }

  // Duplicate in attemptedDriverIds
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      runPatch: {
        attemptedDriverIds: ['driver_test_1', 'driver_test_1'],
      },
    });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_INVALID' }
    );
  }
});

test('P1 Unit: second candidate simultaneously offered fails closed', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    runPatch: {
      candidates: [
        { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
        { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'offered', reasonCode: null }, // Second offered!
      ],
      nextCandidateIndex: 1,
      attemptedDriverIds: ['driver_test_1'],
    },
  });
  const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
  await assert.rejects(
    () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
    { code: 'RUN_INVALID' }
  );
});

test('P1 Unit: future candidate has non-pending outcome or appears in attempted history fails closed', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // Future candidate has outcome = 'expired'
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      runPatch: {
        candidates: [
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
          { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'expired', reasonCode: null },
        ],
        nextCandidateIndex: 1,
        attemptedDriverIds: ['driver_test_1'],
      },
    });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_INVALID' }
    );
  }

  // Future driver in attemptedDriverIds
  {
    const { db, jobId, offerId, generation } = setupSeed({
      nowMs: baseTime,
      runPatch: {
        candidates: [
          { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
          { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'pending', reasonCode: null },
        ],
        nextCandidateIndex: 1,
        attemptedDriverIds: ['driver_test_1', 'driver_test_2'], // driver_test_2 is future!
      },
    });
    const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
    await assert.rejects(
      () => manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation }),
      { code: 'RUN_ATTEMPTED_DRIVERS_MISMATCH' }
    );
  }
});

test('P1 Unit: legitimate later candidate current offer succeeds cleanly', async () => {
  const baseTime = 1000000;
  const expiryTime = baseTime + 45000;

  // Candidate index 1 is offered after candidate 0 timed out (outcome: 'expired')
  const { db, jobId, offerId, generation } = setupSeed({
    nowMs: baseTime,
    offerPatch: { candidateIndex: 1, driverId: 'driver_test_2' },
    jobPatch: { offeredTo: 'driver_test_2' },
    runPatch: {
      candidates: [
        { driverId: 'driver_test_1', roundIndex: 0, haversineDistanceKm: 3.5, matrixEtaSeconds: 600, matrixDistanceMeters: 5000, rankingMode: 'ola', outcome: 'expired', reasonCode: null },
        { driverId: 'driver_test_2', roundIndex: 0, haversineDistanceKm: 4.0, matrixEtaSeconds: 700, matrixDistanceMeters: 6000, rankingMode: 'ola', outcome: 'offered', reasonCode: null },
        { driverId: 'driver_test_3', roundIndex: 0, haversineDistanceKm: 4.5, matrixEtaSeconds: 800, matrixDistanceMeters: 7000, rankingMode: 'ola', outcome: 'pending', reasonCode: null },
      ],
      nextCandidateIndex: 2,
      attemptedDriverIds: ['driver_test_1', 'driver_test_2'],
    },
  });
  db.seed('drivers', 'driver_test_2', { ...db.read('drivers', 'driver_test_1'), activeOfferId: offerId });

  const manager = createOfferTimeoutManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(expiryTime + 1000) });
  const result = await manager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: generation });

  assert.equal(result.expired, true);
  assert.equal(result.candidateIndex, 1);
  assert.equal(result.driverId, 'driver_test_2');

  const run = db.read(`jobs/${jobId}/dispatch_runs`, String(generation));
  assert.equal(run.candidates[0].outcome, 'expired');
  assert.equal(run.candidates[1].outcome, 'expired');
  assert.equal(run.candidates[2].outcome, 'pending');
  assert.equal(run.nextCandidateIndex, 2); // Preserved
});
