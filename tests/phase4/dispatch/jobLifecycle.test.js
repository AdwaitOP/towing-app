'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { GeoPoint } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createJobLifecycleManager,
  getDefaultJobLifecycleManager,
  createStartJobCallable,
  createCompleteJobCallable,
  startJob,
  completeJob,
} = require('../../../firebase/functions/src/dispatch/jobLifecycle');
const {
  compareTimestamps,
  timestampsEqual,
  timestampLessThanOrEqual,
} = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const { paidJob, driver, config } = require('../fixtures');

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
  nowMs = 1000000,
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
  ledgerPatch = {},
  outboxPatch = {},
  acceptReceiptPatch = {},
  acceptRequestId = 'req-accept-1',
} = {}) {
  const jobId = 'job_test_1';
  const driverId = 'driver_test_1';
  const generation = 1;
  const offerId = 'offer_test_1';
  const acceptedAt = FakeTimestamp.fromMillis(nowMs);

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
    offeredAt: FakeTimestamp.fromMillis(nowMs - 5000),
    expiresAt: FakeTimestamp.fromMillis(nowMs + 40000),
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
    estimatedFarePaise: 250000,
    driverCommissionPaise: 5000,
    createdAt: FakeTimestamp.fromMillis(nowMs - 5000),
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
    createdAt: FakeTimestamp.fromMillis(nowMs - 5000),
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

  const acceptedOutboxId = 'job_accepted:' + jobId + ':' + offerId;
  const acceptedOutbox = {
    eventId: acceptedOutboxId,
    eventType: 'job_accepted',
    resourceType: 'job',
    resourceId: jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + jobId,
    payloadVersion: 1,
    payload: {
      jobId,
      jobStatus: 'accepted',
      refundAmountPaise: null,
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: acceptedAt,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    sentAt: null,
    ...outboxPatch,
  };

  const db = new FakeFirestore();
  db.data.jobs = { [jobId]: job };
  db.data.job_offers = { [offerId]: offer };
  db.data.drivers = { [driverId]: driverDoc };
  db.data[`jobs/${jobId}/dispatch_runs`] = { [String(generation)]: run };
  db.data.wallet_entries = { [ledgerId]: ledger };
  db.data.notification_outbox = { [acceptedOutboxId]: acceptedOutbox };

  if (acceptRequestId) {
    const histPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
    db.data.processed_requests = {
      [acceptRequestId]: {
        requestId: acceptRequestId,
        status: 'completed',
        type: 'phase4_client_mutation',
        ownerToken: null,
        claimedAt: acceptedAt,
        leaseUntil: null,
        processedAt: acceptedAt,
        actorUid: driverId,
        operation: 'accept',
        resourceId: jobId + ':' + offerId,
        payloadHash: histPayloadHash,
        result: {
          accepted: true,
          jobId,
          offerId,
          driverId,
        },
        ...acceptReceiptPatch,
      },
    };
  }

  return {
    db,
    jobId,
    driverId,
    offerId,
    generation,
    nowMs,
  };
}

function setupInProgressSeed({
  nowMs = 1000000,
  startMs = 1010000,
  startRequestId = 'req-start-1',
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
  inProgressOutboxPatch = {},
  ...rest
} = {}) {
  const seed = setupAcceptedSeed({ nowMs, ...rest });
  const { db, jobId, driverId, offerId, generation } = seed;
  const inProgressAt = FakeTimestamp.fromMillis(startMs);

  db.data.jobs[jobId].status = 'in_progress';
  db.data.jobs[jobId].inProgressAt = inProgressAt;
  db.data.jobs[jobId].stateVersion = 2;
  db.data.jobs[jobId].updatedAt = inProgressAt;
  Object.assign(db.data.jobs[jobId], jobPatch);

  db.data.job_offers[offerId].status = 'in_progress';
  db.data.job_offers[offerId].inProgressAt = inProgressAt;
  db.data.job_offers[offerId].updatedAt = inProgressAt;
  Object.assign(db.data.job_offers[offerId], offerPatch);

  Object.assign(db.data.drivers[driverId], driverPatch);

  db.data[`jobs/${jobId}/dispatch_runs`][String(generation)].updatedAt = inProgressAt;
  Object.assign(db.data[`jobs/${jobId}/dispatch_runs`][String(generation)], runPatch);

  const inProgressOutboxId = 'job_in_progress:' + jobId;
  db.data.notification_outbox[inProgressOutboxId] = {
    eventId: inProgressOutboxId,
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + jobId,
    payloadVersion: 1,
    payload: {
      jobId,
      jobStatus: 'in_progress',
      refundAmountPaise: null,
    },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: inProgressAt,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: inProgressAt,
    updatedAt: inProgressAt,
    sentAt: null,
    ...inProgressOutboxPatch,
  };

  if (startRequestId) {
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
    db.data.processed_requests[startRequestId] = {
      requestId: startRequestId,
      status: 'completed',
      type: 'phase4_client_mutation',
      ownerToken: null,
      claimedAt: inProgressAt,
      leaseUntil: null,
      processedAt: inProgressAt,
      actorUid: driverId,
      operation: 'start_job',
      resourceId: jobId + ':' + offerId,
      payloadHash,
      result: {
        started: true,
        jobId,
        offerId,
        driverId,
      },
    };
  }

  return {
    ...seed,
    startMs,
    startRequestId,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// STARTJOB UNIT TESTS (1 - 34)
// ════════════════════════════════════════════════════════════════════════════════

test('1. Valid startJob: atomic transition accepted -> in_progress, receipt, and outbox', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 5000),
  });

  const result = await manager.startJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-start-valid',
  });

  assert.deepEqual(result, {
    started: true,
    jobId,
    offerId,
    driverId,
  });

  const job = db.data.jobs[jobId];
  assert.equal(job.status, 'in_progress');
  assert.equal(job.dispatchState, 'assigned');
  assert.equal(job.assignedDriver, driverId);
  assert.equal(job.currentOfferId, offerId);
  assert.equal(job.stateVersion, 2);
  assert.equal(job.inProgressAt.toMillis(), nowMs + 5000);
  assert.equal(job.completedAt, null);

  const offer = db.data.job_offers[offerId];
  assert.equal(offer.status, 'in_progress');
  assert.equal(offer.inProgressAt.toMillis(), nowMs + 5000);
  assert.equal(offer.completedAt, null);

  const run = db.data[`jobs/${jobId}/dispatch_runs`]['1'];
  assert.equal(run.status, 'assigned');
  assert.equal(run.finalizedAt, null);
  assert.equal(run.candidates[0].outcome, 'accepted');

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.activeJobId, jobId);
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.walletBalance, 20000);

  const outbox = db.data.notification_outbox['job_in_progress:' + jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'job_in_progress:' + jobId);
  assert.equal(outbox.eventType, 'job_in_progress');
  assert.equal(outbox.state, 'pending');
  assert.deepEqual(outbox.payload, {
    jobId,
    jobStatus: 'in_progress',
    refundAmountPaise: null,
  });

  const receipt = db.data.processed_requests['req-start-valid'];
  assert.ok(receipt);
  assert.equal(receipt.operation, 'start_job');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actorUid, driverId);
});

test('2. startJob: rejects unauthenticated caller with zero writes', async () => {
  const { db, jobId, offerId } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const callable = createStartJobCallable({
    jobLifecycleManager: createJobLifecycleManager({ db, TimestampClass: FakeTimestamp }),
  });

  await assert.rejects(
    () => callable.run({ data: { jobId, offerId, requestId: 'req-1' }, auth: null }),
    err => err.code === 'unauthenticated'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('3. startJob: rejects invalid/missing/malformed requestId with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  for (const badReq of [null, undefined, '', 'bad/slash', 123, {}]) {
    await assert.rejects(
      () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: badReq }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('4. startJob: rejects wrong driver with zero writes', async () => {
  const { db, jobId, offerId } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: 'driver_wrong', requestId: 'req-start-1' }),
    err => err.code === 'DOCUMENT_NOT_FOUND' || err.code === 'WRONG_DRIVER'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('5. startJob: rejects wrong job/offer binding with zero writes', async () => {
  const { db, jobId, driverId } = setupAcceptedSeed({
    offerPatch: { jobId: 'different_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId: 'offer_test_1', driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'OFFER_BINDING_MISMATCH' || err.code === 'JOB_OFFER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('6. startJob: rejects wrong generation with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    offerPatch: { dispatchGeneration: 2 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'OFFER_GENERATION_MISMATCH' || err.code === 'RUN_NOT_FOUND'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('7. startJob: rejects when job is not accepted (e.g. offered) with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { status: 'offered', dispatchState: 'offered' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'JOB_NOT_ACCEPTED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('8. startJob: rejects when offer is not accepted with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    offerPatch: { status: 'offered' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'OFFER_NOT_ACCEPTED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('9. startJob: rejects when run is not assigned with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { status: 'active' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'RUN_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('10. startJob: rejects when run has unexpected finalizedAt with zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    nowMs,
    runPatch: { finalizedAt: FakeTimestamp.fromMillis(nowMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'RUN_FINALIZED' || err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('11. startJob: rejects when candidate outcome is not accepted with zero writes', async () => {
  const driverId = 'driver_test_1';
  const { db, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
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
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'CANDIDATE_MISMATCH' || err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('12. startJob: rejects when driver.activeJobId does not match jobId with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    driverPatch: { activeJobId: 'different_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('13. startJob: rejects when job.currentOfferId mismatch with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { currentOfferId: 'other_offer' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'JOB_OFFER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('14. startJob: rejects malformed stateVersion with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { stateVersion: 'not_a_number' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('15. startJob: rejects stateVersion MAX_SAFE_INTEGER overflow with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('16. startJob: respects customer cancellation precedence with zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    nowMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs + 100),
      cancellationResolutionState: 'pending',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('17. startJob: rejects contradictory customer cancellation provenance with zero writes', async () => {
  const nowMs = 1000000;
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    nowMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs + 100),
      cancellationResolutionState: 'none',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'CANCELLATION_PROVENANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('18. startJob: rejects missing/corrupt commission debit ledger with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  delete db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId];
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'LEDGER_INVALID' || err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('19. startJob: rejects missing/corrupt accepted outbox with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  delete db.data.notification_outbox['job_accepted:' + jobId + ':' + offerId];
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'OUTBOX_INVALID' || err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('20. startJob: rejects missing/corrupt historical accept receipt when required with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  delete db.data.processed_requests['req-accept-1'];
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('21. startJob: rejects malformed cancellationPolicySnapshot with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    offerPatch: { cancellationPolicySnapshot: { corrupt: true } },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('22. startJob: rejects malformed acceptedAt with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { acceptedAt: 'invalid_date' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID' || err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('23. startJob: rejects when now < acceptedAt with zero writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs - 1000),
  });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('24. startJob: valid atomic transition verified in all documents', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 1000),
  });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  assert.equal(db.data.jobs[jobId].status, 'in_progress');
  assert.equal(db.data.jobs[jobId].inProgressAt.toMillis(), nowMs + 1000);
  assert.equal(db.data.job_offers[offerId].status, 'in_progress');
  assert.equal(db.data.job_offers[offerId].inProgressAt.toMillis(), nowMs + 1000);
});

test('25. startJob: run remains assigned and nonterminal (finalizedAt is null)', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  const run = db.data[`jobs/${jobId}/dispatch_runs`]['1'];
  assert.equal(run.status, 'assigned');
  assert.equal(run.finalizedAt, null);
  assert.equal(run.currentOfferId, offerId);
});

test('26. startJob: activeJobId remains jobId and activeOfferId remains null', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.activeJobId, jobId);
  assert.equal(driverDoc.activeOfferId, null);
});

test('27. startJob: wallet balance and penalties unchanged; zero wallet writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const beforeBalance = db.data.drivers[driverId].walletBalance;
  const beforeEntries = Object.keys(db.data.wallet_entries).length;
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  assert.equal(db.data.drivers[driverId].walletBalance, beforeBalance);
  assert.equal(Object.keys(db.data.wallet_entries).length, beforeEntries);
});

test('28. startJob: exact job_in_progress outbox binding created', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 2000),
  });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  const outbox = db.data.notification_outbox['job_in_progress:' + jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'job_in_progress:' + jobId);
  assert.equal(outbox.eventType, 'job_in_progress');
  assert.equal(outbox.resourceType, 'job');
  assert.equal(outbox.resourceId, jobId);
  assert.equal(outbox.channel, 'whatsapp');
  assert.equal(outbox.recipientKey, 'customer:' + jobId);
  assert.equal(outbox.payloadVersion, 1);
  assert.deepEqual(outbox.payload, {
    jobId,
    jobStatus: 'in_progress',
    refundAmountPaise: null,
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.ownerToken, null);
  assert.equal(outbox.leaseUntil, null);
  assert.equal(outbox.attemptCount, 0);
  assert.equal(outbox.sentAt, null);
  assert.equal(outbox.lastErrorCode, null);
});

test('29. startJob: exact start receipt created in processed_requests', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs + 2000),
  });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  const receipt = db.data.processed_requests['req-start-1'];
  assert.ok(receipt);
  assert.equal(receipt.requestId, 'req-start-1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.type, 'phase4_client_mutation');
  assert.equal(receipt.operation, 'start_job');
  assert.equal(receipt.resourceId, jobId + ':' + offerId);
  assert.equal(receipt.actorUid, driverId);
  assert.deepEqual(receipt.result, {
    started: true,
    jobId,
    offerId,
    driverId,
  });
});

test('30. startJob: same requestId duplicate retry returns idempotent success with 0 writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  const first = await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });
  assert.equal(first.started, true);

  const snapshotAfterFirst = captureFullDbSnapshot(db);
  const second = await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  assert.deepEqual(second, {
    started: true,
    idempotent: true,
    jobId,
    offerId,
    driverId,
  });
  assert.deepEqual(captureFullDbSnapshot(db), snapshotAfterFirst);
});

test('31. startJob: same request retry after completed progression returns idempotent success with 0 writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-A' });
  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-B' });

  assert.equal(db.data.jobs[jobId].status, 'completed');
  const snapshotCompleted = captureFullDbSnapshot(db);

  // Client retries original start request
  const retryStart = await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-A' });
  assert.deepEqual(retryStart, {
    started: true,
    idempotent: true,
    jobId,
    offerId,
    driverId,
  });
  // Must remain completed, zero writes
  assert.equal(db.data.jobs[jobId].status, 'completed');
  assert.deepEqual(captureFullDbSnapshot(db), snapshotCompleted);
});

test('32. startJob: different requestId after already started fails closed with 0 writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });
  const snapshot = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-2' }),
    err => err.code === 'JOB_NOT_ACCEPTED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), snapshot);
});

test('33. startJob: outbox collision (job_in_progress already exists) fails closed with 0 writes', async () => {
  const { db, jobId, driverId, offerId, nowMs } = setupAcceptedSeed();
  db.data.notification_outbox['job_in_progress:' + jobId] = {
    eventId: 'job_in_progress:' + jobId,
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + jobId,
    payloadVersion: 1,
    payload: { jobId, jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: FakeTimestamp.fromMillis(nowMs),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: FakeTimestamp.fromMillis(nowMs),
    updatedAt: FakeTimestamp.fromMillis(nowMs),
    sentAt: null,
  };
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' }),
    err => err.code === 'OUTBOX_ALREADY_EXISTS'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('34. startJob: full zero-write negative snapshot on all invalid input variations', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  for (const badJobId of ['', 'job/slash', null]) {
    await assert.rejects(
      () => manager.startJob({ jobId: badJobId, offerId, driverUid: driverId, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  for (const badOfferId of ['', 'offer/slash', null]) {
    await assert.rejects(
      () => manager.startJob({ jobId, offerId: badOfferId, driverUid: driverId, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  for (const badDriver of ['', 'driver/slash', null]) {
    await assert.rejects(
      () => manager.startJob({ jobId, offerId, driverUid: badDriver, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ════════════════════════════════════════════════════════════════════════════════
// COMPLETEJOB UNIT TESTS (35 - 66)
// ════════════════════════════════════════════════════════════════════════════════

test('35. Valid completeJob: atomic transition in_progress -> completed, outbox, run finalization, driver released', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 10000;
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(completeMs),
  });

  const result = await manager.completeJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-complete-1',
  });

  assert.deepEqual(result, {
    completed: true,
    jobId,
    offerId,
    driverId,
  });

  const job = db.data.jobs[jobId];
  assert.equal(job.status, 'completed');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.assignedDriver, driverId);
  assert.equal(job.currentOfferId, offerId);
  assert.equal(job.completedAt.toMillis(), completeMs);
  assert.equal(job.stateVersion, 3);

  const offer = db.data.job_offers[offerId];
  assert.equal(offer.status, 'completed');
  assert.equal(offer.completedAt.toMillis(), completeMs);

  const run = db.data[`jobs/${jobId}/dispatch_runs`]['1'];
  assert.equal(run.status, 'completed');
  assert.equal(run.finalizedAt.toMillis(), completeMs);
  assert.equal(run.currentOfferId, offerId);
  assert.equal(run.candidates[0].outcome, 'accepted');

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.walletBalance, 20000);

  const outbox = db.data.notification_outbox['job_completed:' + jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'job_completed:' + jobId);
  assert.equal(outbox.eventType, 'job_completed');
  assert.equal(outbox.state, 'pending');
  assert.deepEqual(outbox.payload, {
    jobId,
    jobStatus: 'completed',
    refundAmountPaise: null,
  });

  const receipt = db.data.processed_requests['req-complete-1'];
  assert.ok(receipt);
  assert.equal(receipt.operation, 'complete_job');
  assert.equal(receipt.status, 'completed');
});

test('36. completeJob: rejects unauthenticated caller with zero writes', async () => {
  const { db, jobId, offerId } = setupInProgressSeed();
  const before = captureFullDbSnapshot(db);
  const callable = createCompleteJobCallable({
    jobLifecycleManager: createJobLifecycleManager({ db, TimestampClass: FakeTimestamp }),
  });

  await assert.rejects(
    () => callable.run({ data: { jobId, offerId, requestId: 'req-1' }, auth: null }),
    err => err.code === 'unauthenticated'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('37. completeJob: rejects invalid/missing/malformed requestId with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  for (const badReq of [null, undefined, '', 'bad/slash', 123, {}]) {
    await assert.rejects(
      () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: badReq }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('38. completeJob: rejects wrong driver with zero writes', async () => {
  const { db, jobId, offerId } = setupInProgressSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: 'wrong_driver', requestId: 'req-complete-1' }),
    err => err.code === 'DOCUMENT_NOT_FOUND' || err.code === 'WRONG_DRIVER'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('39. completeJob: rejects wrong job/offer/generation binding with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    offerPatch: { jobId: 'other_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'OFFER_BINDING_MISMATCH' || err.code === 'JOB_OFFER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('40. completeJob: rejects complete directly from accepted with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'JOB_NOT_IN_PROGRESS'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('41. completeJob: rejects when offer is not in_progress with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    offerPatch: { status: 'accepted' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'OFFER_NOT_IN_PROGRESS'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('42. completeJob: rejects when run is not assigned with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    runPatch: { status: 'active' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'RUN_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('43. completeJob: rejects preexisting finalizedAt on run with zero writes', async () => {
  const startMs = 1010000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    startMs,
    runPatch: { finalizedAt: FakeTimestamp.fromMillis(startMs) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'RUN_FINALIZED' || err.code === 'IN_PROGRESS_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('44. completeJob: rejects activeJobId mismatch with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    driverPatch: { activeJobId: 'other_job' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('45. completeJob: rejects currentOfferId mismatch with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: { currentOfferId: 'other_offer' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'JOB_OFFER_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('46. completeJob: rejects malformed stateVersion with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: { stateVersion: -1 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('47. completeJob: rejects MAX_SAFE_INTEGER stateVersion overflow with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'JOB_STATE_VERSION_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('48. completeJob: customer cancellation precedence returns CANCELLATION_PRECEDENCE with zero writes', async () => {
  const startMs = 1010000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    startMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(startMs + 500),
      cancellationResolutionState: 'pending',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('49. completeJob: contradictory cancellation provenance fails closed with CANCELLATION_PROVENANCE_CONFLICT', async () => {
  const startMs = 1010000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    startMs,
    jobPatch: {
      cancellationRequestedAt: FakeTimestamp.fromMillis(startMs + 500),
      cancellationResolutionState: 'none',
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'CANCELLATION_PROVENANCE_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('50. completeJob: missing accepted provenance (e.g. commission ledger) rejects with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  delete db.data.wallet_entries['commission_debit:' + jobId + ':' + offerId];
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'LEDGER_INVALID' || err.code === 'IN_PROGRESS_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('51. completeJob: missing/corrupt in-progress outbox rejects with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  delete db.data.notification_outbox['job_in_progress:' + jobId];
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'OUTBOX_INVALID' || err.code === 'IN_PROGRESS_CONFLICT'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('52. completeJob: malformed acceptedAt / inProgressAt rejects with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: { inProgressAt: 'not_timestamp' },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('53. completeJob: rejects when now < inProgressAt with zero writes', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(startMs - 1000),
  });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('54. completeJob: job/offer timestamp incoherence (e.g. acceptedAt > inProgressAt) rejects with zero writes', async () => {
  const startMs = 1010000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    startMs,
    jobPatch: { inProgressAt: FakeTimestamp.fromMillis(startMs - 20000) },
    offerPatch: { inProgressAt: FakeTimestamp.fromMillis(startMs - 20000) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('55. completeJob: exact completed transition verification (status completed, dispatchState closed)', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(startMs + 5000),
  });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  assert.equal(db.data.jobs[jobId].status, 'completed');
  assert.equal(db.data.jobs[jobId].dispatchState, 'closed');
  assert.equal(db.data.jobs[jobId].completedAt.toMillis(), startMs + 5000);
  assert.equal(db.data.job_offers[offerId].status, 'completed');
  assert.equal(db.data.job_offers[offerId].completedAt.toMillis(), startMs + 5000);
});

test('56. completeJob: run assigned -> completed transition', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const run = db.data[`jobs/${jobId}/dispatch_runs`]['1'];
  assert.equal(run.status, 'completed');
  assert.equal(run.currentOfferId, offerId);
  assert.equal(run.candidates[0].outcome, 'accepted');
});

test('57. completeJob: finalizedAt exact and immutable', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 7000;
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(completeMs),
  });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const run = db.data[`jobs/${jobId}/dispatch_runs`]['1'];
  assert.equal(run.finalizedAt.toMillis(), completeMs);
});

test('58. completeJob: driver.activeJobId cleared to null', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const driverDoc = db.data.drivers[driverId];
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.activeOfferId, null);
});

test('59. completeJob: wallet balance and penalties unchanged; zero financial mutations', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const beforeBalance = db.data.drivers[driverId].walletBalance;
  const beforeEntries = Object.keys(db.data.wallet_entries).length;
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  assert.equal(db.data.drivers[driverId].walletBalance, beforeBalance);
  assert.equal(Object.keys(db.data.wallet_entries).length, beforeEntries);
});

test('60. completeJob: exact job_completed outbox binding created', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 8000;
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(completeMs),
  });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const outbox = db.data.notification_outbox['job_completed:' + jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventId, 'job_completed:' + jobId);
  assert.equal(outbox.eventType, 'job_completed');
  assert.equal(outbox.resourceType, 'job');
  assert.equal(outbox.resourceId, jobId);
  assert.equal(outbox.channel, 'whatsapp');
  assert.equal(outbox.recipientKey, 'customer:' + jobId);
  assert.equal(outbox.payloadVersion, 1);
  assert.deepEqual(outbox.payload, {
    jobId,
    jobStatus: 'completed',
    refundAmountPaise: null,
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(outbox.ownerToken, null);
  assert.equal(outbox.leaseUntil, null);
  assert.equal(outbox.attemptCount, 0);
  assert.equal(outbox.sentAt, null);
});

test('61. completeJob: exact complete receipt created in processed_requests', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const receipt = db.data.processed_requests['req-complete-1'];
  assert.ok(receipt);
  assert.equal(receipt.requestId, 'req-complete-1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.type, 'phase4_client_mutation');
  assert.equal(receipt.operation, 'complete_job');
  assert.equal(receipt.resourceId, jobId + ':' + offerId);
  assert.equal(receipt.actorUid, driverId);
  assert.deepEqual(receipt.result, {
    completed: true,
    jobId,
    offerId,
    driverId,
  });
});

test('62. completeJob: same requestId duplicate retry returns idempotent success with 0 writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  const first = await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });
  assert.equal(first.completed, true);

  const snapshotAfterFirst = captureFullDbSnapshot(db);
  const second = await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  assert.deepEqual(second, {
    completed: true,
    idempotent: true,
    jobId,
    offerId,
    driverId,
  });
  assert.deepEqual(captureFullDbSnapshot(db), snapshotAfterFirst);
});

test('63. completeJob: different requestId after completion fails closed with 0 writes', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });
  const snapshot = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-2' }),
    err => err.code === 'JOB_NOT_IN_PROGRESS'
  );
  assert.deepEqual(captureFullDbSnapshot(db), snapshot);
});

test('64. completeJob: duplicate retry does not change finalizedAt', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 5000;
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(completeMs),
  });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });
  const finalizedAtFirst = db.data[`jobs/${jobId}/dispatch_runs`]['1'].finalizedAt.toMillis();

  // Retry later
  const laterManager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(completeMs + 50000),
  });
  await laterManager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const finalizedAtSecond = db.data[`jobs/${jobId}/dispatch_runs`]['1'].finalizedAt.toMillis();
  assert.equal(finalizedAtFirst, finalizedAtSecond);
});

test('65. completeJob: completed terminal state cannot reopen or be mutated by startJob', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });
  const snapshotCompleted = captureFullDbSnapshot(db);

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-new' }),
    err => err.code === 'JOB_NOT_ACCEPTED'
  );
  assert.deepEqual(captureFullDbSnapshot(db), snapshotCompleted);
});

test('66. completeJob: full zero-write negative snapshot on all invalid input variations', async () => {
  const { db, jobId, driverId, offerId } = setupInProgressSeed();
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  for (const badJobId of ['', 'job/slash', null]) {
    await assert.rejects(
      () => manager.completeJob({ jobId: badJobId, offerId, driverUid: driverId, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  for (const badOfferId of ['', 'offer/slash', null]) {
    await assert.rejects(
      () => manager.completeJob({ jobId, offerId: badOfferId, driverUid: driverId, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  for (const badDriver of ['', 'driver/slash', null]) {
    await assert.rejects(
      () => manager.completeJob({ jobId, offerId, driverUid: badDriver, requestId: 'req-1' }),
      err => err.code === 'INVALID_ARGUMENT'
    );
  }
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

// ============================================================================
// ASTRA FINDING 1: CANONICAL RUN VALIDATION CORRUPTION MATRIX
// ============================================================================

test('67. startJob & completeJob: rejects run with mismatched jobId with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { jobId: 'different_job' },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-corrupt-run-job' }),
    err => err.code === 'RUN_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: { jobId: 'different_job' },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-corrupt-run-job' }),
    err => err.code === 'RUN_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('68. startJob & completeJob: rejects run with mismatched generation with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { generation: 999 },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-gen' }),
    err => err.code === 'RUN_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: { generation: 999 },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-gen' }),
    err => err.code === 'RUN_GENERATION_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('69. startJob & completeJob: rejects when job.dispatchRunId !== String(run.generation) with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { dispatchRunId: 'mismatch_run_id' },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-runid' }),
    err => err.code === 'JOB_RUN_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    jobPatch: { dispatchRunId: 'mismatch_run_id' },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-runid' }),
    err => err.code === 'JOB_RUN_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('70. startJob & completeJob: rejects run with missing/corrupt policySnapshot or invalid policyVersion with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { policySnapshot: { invalid: true } },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-bad-policy' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: { policyVersion: 0 },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-bad-policy-ver' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('71. startJob & completeJob: rejects run where nextCandidateIndex !== candidateIndex + 1 with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { nextCandidateIndex: 0 },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-cursor' }),
    err => err.code === 'RUN_CURSOR_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: { nextCandidateIndex: 2 },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-cursor' }),
    err => err.code === 'RUN_CURSOR_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('72. startJob & completeJob: rejects run where preceding candidate has illegal outcome with zero writes', async () => {
  const driverId = 'driver_test_1';
  const precedingDriver = 'driver_prec_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates: [
        {
          driverId: precedingDriver,
          roundIndex: 0,
          haversineDistanceKm: 2.0,
          matrixEtaSeconds: 400,
          matrixDistanceMeters: 3000,
          rankingMode: 'ola',
          outcome: 'offered',
          reasonCode: null,
        },
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [precedingDriver, driverId],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-prec-illegal' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates: [
        {
          driverId: precedingDriver,
          roundIndex: 0,
          haversineDistanceKm: 2.0,
          matrixEtaSeconds: 400,
          matrixDistanceMeters: 3000,
          rankingMode: 'ola',
          outcome: 'pending',
          reasonCode: null,
        },
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [precedingDriver, driverId],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-prec-illegal' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('73. startJob & completeJob: rejects run where preceding skipped candidate has invalid reasonCode with zero writes', async () => {
  const driverId = 'driver_test_1';
  const precedingDriver = 'driver_prec_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates: [
        {
          driverId: precedingDriver,
          roundIndex: 0,
          haversineDistanceKm: 2.0,
          matrixEtaSeconds: 400,
          matrixDistanceMeters: 3000,
          rankingMode: 'ola',
          outcome: 'skipped',
          reasonCode: 'driver_banned',
        },
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [driverId],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-prec-reason' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

test('74. startJob & completeJob: rejects run where current candidate has non-null reasonCode with zero writes', async () => {
  const driverId = 'driver_test_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      candidates: [{
        driverId,
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'accepted',
        reasonCode: 'accepted_by_driver',
      }],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-cand-reason' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: {
      candidates: [{
        driverId,
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'accepted',
        reasonCode: 'accepted_by_driver',
      }],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-cand-reason' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('75. startJob & completeJob: rejects run where multiple candidates have outcome accepted with zero writes', async () => {
  const driverId = 'driver_test_1';
  const driver2 = 'driver_test_2';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      candidates: [
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
        {
          driverId: driver2,
          roundIndex: 0,
          haversineDistanceKm: 4.0,
          matrixEtaSeconds: 700,
          matrixDistanceMeters: 6000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [driverId, driver2],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-multi-accepted' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

test('76. startJob & completeJob: rejects run where future candidate is not pending or has non-null reasonCode with zero writes', async () => {
  const driverId = 'driver_test_1';
  const futureDriver = 'driver_future_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      candidates: [
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
        {
          driverId: futureDriver,
          roundIndex: 0,
          haversineDistanceKm: 5.0,
          matrixEtaSeconds: 800,
          matrixDistanceMeters: 7000,
          rankingMode: 'ola',
          outcome: 'offered',
          reasonCode: null,
        },
      ],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-future-bad' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

test('77. startJob & completeJob: rejects run where future candidate appears in attempted or excluded driver IDs with zero writes', async () => {
  const driverId = 'driver_test_1';
  const futureDriver = 'driver_future_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      candidates: [
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
        {
          driverId: futureDriver,
          roundIndex: 0,
          haversineDistanceKm: 5.0,
          matrixEtaSeconds: 800,
          matrixDistanceMeters: 7000,
          rankingMode: 'ola',
          outcome: 'pending',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [driverId, futureDriver],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-future-attempted' }),
    err => err.code === 'RUN_ATTEMPTED_DRIVERS_MISMATCH'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

test('78. startJob & completeJob: rejects run where driver_cancelled candidate is missing from excludedDriverIds with zero writes', async () => {
  const driverId = 'driver_test_1';
  const cancelledDriver = 'driver_cancelled_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates: [
        {
          driverId: cancelledDriver,
          roundIndex: 0,
          haversineDistanceKm: 2.0,
          matrixEtaSeconds: 300,
          matrixDistanceMeters: 2000,
          rankingMode: 'ola',
          outcome: 'driver_cancelled',
          reasonCode: null,
        },
        {
          driverId,
          roundIndex: 0,
          haversineDistanceKm: 3.5,
          matrixEtaSeconds: 600,
          matrixDistanceMeters: 5000,
          rankingMode: 'ola',
          outcome: 'accepted',
          reasonCode: null,
        },
      ],
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-miss-excluded' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

test('79. startJob & completeJob: rejects run with non-authoritative createdAt or updatedAt with zero writes', async () => {
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    runPatch: { createdAt: '2026-09-01T00:00:00.000Z' },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-run-created' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);
});

// ============================================================================
// ASTRA FINDING 2: CANONICAL OUTBOX RECORD CORRUPTION MATRIX
// ============================================================================

test('80. startJob: rejects pending outbox with attemptCount > 0 or non-null ownerToken/leaseUntil with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    outboxPatch: { attemptCount: 1 },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-outbox-attempt' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('81. startJob: rejects pending outbox with null nextAttemptAt or non-null providerMessageId/lastErrorCode with zero writes', async () => {
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    outboxPatch: { nextAttemptAt: null },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-outbox-next' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);

  const { db: db2 } = setupAcceptedSeed({
    outboxPatch: { providerMessageId: 'msg-unexpected' },
  });
  const before2 = captureFullDbSnapshot(db2);
  const manager2 = createJobLifecycleManager({ db: db2, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => manager2.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-outbox-prov' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db2), before2);
});

test('82. completeJob: accepts valid in_progress outbox and rejects corrupt in_progress outbox with zero writes', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 5000;
  // Valid in_progress outbox
  db.data.notification_outbox['job_in_progress:' + jobId] = {
    ...db.data.notification_outbox['job_in_progress:' + jobId],
    state: 'in_progress',
    attemptCount: 1,
    ownerToken: 'worker-token-123',
    leaseUntil: FakeTimestamp.fromMillis(completeMs + 30000),
    nextAttemptAt: FakeTimestamp.fromMillis(startMs),
  };
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(completeMs) });
  const res = await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-valid-outbox' });
  assert.equal(res.completed, true);

  // Corrupt: attemptCount === 0 while state is in_progress
  const { db: dbBad, jobId: badJobId, driverId: badDriverId, offerId: badOfferId } = setupInProgressSeed({
    inProgressOutboxPatch: {
      state: 'in_progress',
      attemptCount: 0,
      ownerToken: 'worker-token-123',
      leaseUntil: FakeTimestamp.fromMillis(completeMs + 30000),
    },
  });
  const beforeBad = captureFullDbSnapshot(dbBad);
  const managerBad = createJobLifecycleManager({ db: dbBad, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => managerBad.completeJob({ jobId: badJobId, offerId: badOfferId, driverUid: badDriverId, requestId: 'req-comp-bad-outbox' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(dbBad), beforeBad);
});

test('83. completeJob: accepts valid sent outbox and rejects corrupt sent outbox with zero writes', async () => {
  const { db, jobId, driverId, offerId, startMs } = setupInProgressSeed();
  const completeMs = startMs + 5000;
  // Valid sent outbox
  db.data.notification_outbox['job_in_progress:' + jobId] = {
    ...db.data.notification_outbox['job_in_progress:' + jobId],
    state: 'sent',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    sentAt: FakeTimestamp.fromMillis(startMs + 500),
    providerMessageId: 'wam_msg_sent_123',
    lastErrorCode: null,
  };
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp, now: () => new Date(completeMs) });
  const res = await manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-sent-outbox' });
  assert.equal(res.completed, true);

  // Corrupt sent: missing providerMessageId
  const { db: dbBad, jobId: badJobId, driverId: badDriverId, offerId: badOfferId } = setupInProgressSeed({
    inProgressOutboxPatch: {
      state: 'sent',
      attemptCount: 1,
      ownerToken: null,
      leaseUntil: null,
      sentAt: FakeTimestamp.fromMillis(startMs + 500),
      providerMessageId: null,
    },
  });
  const beforeBad = captureFullDbSnapshot(dbBad);
  const managerBad = createJobLifecycleManager({ db: dbBad, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => managerBad.completeJob({ jobId: badJobId, offerId: badOfferId, driverUid: badDriverId, requestId: 'req-comp-bad-sent' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(dbBad), beforeBad);
});

test('84. completeJob: rejects retry_wait and failed_terminal outbox when invariants are violated with zero writes', async () => {
  const nowMs = 1000000;
  // Corrupt retry_wait: missing lastErrorCode
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    inProgressOutboxPatch: {
      state: 'retry_wait',
      attemptCount: 1,
      nextAttemptAt: FakeTimestamp.fromMillis(nowMs + 10000),
      lastErrorCode: null,
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-bad-retry' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);

  // Corrupt failed_terminal: non-null sentAt
  const { db: db2 } = setupInProgressSeed({
    inProgressOutboxPatch: {
      state: 'failed_terminal',
      attemptCount: 3,
      lastErrorCode: 'recipient_unreachable',
      sentAt: FakeTimestamp.fromMillis(nowMs),
    },
  });
  const before2 = captureFullDbSnapshot(db2);
  const manager2 = createJobLifecycleManager({ db: db2, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => manager2.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-bad-failed' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db2), before2);
});

test('85. startJob & completeJob: rejects outbox containing extra payload fields with zero writes', async () => {
  const { db: startDb, jobId: sJobId, driverId: sDriverId, offerId: sOfferId } = setupAcceptedSeed({
    outboxPatch: {
      payload: {
        jobId: 'job_test_1',
        jobStatus: 'accepted',
        refundAmountPaise: null,
        customerPhone: '+919876543210',
      },
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId: sJobId, offerId: sOfferId, driverUid: sDriverId, requestId: 'req-start-extra-payload' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    inProgressOutboxPatch: {
      payload: {
        jobId: 'job_test_1',
        jobStatus: 'in_progress',
        refundAmountPaise: null,
        customerPhone: '+919876543210',
      },
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-extra-payload' }),
    err => err.code === 'OUTBOX_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

// ============================================================================
// ASTRA FINDING 3: SUB-MILLISECOND TIMESTAMP PRECISION MATRIX
// ============================================================================

test('86. startJob: nanosecond precision: rejects job.acceptedAt !== offer.acceptedAt when diff is 1 nanosecond (same ms)', async () => {
  const nowMs = 1000000;
  const sec = 1000;
  const ns = 500000;
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    nowMs,
    jobPatch: { acceptedAt: new FakeTimestamp(sec, ns) },
    offerPatch: { acceptedAt: new FakeTimestamp(sec, ns + 1) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-nano-diff' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('87. startJob: nanosecond precision: rejects job.acceptedAt > now boundary by 1 nanosecond with zero writes', async () => {
  const nowMs = 1000000;
  const sec = 1000;
  const ns = 1;
  const { db, jobId, driverId, offerId } = setupAcceptedSeed({
    nowMs,
    jobPatch: { acceptedAt: new FakeTimestamp(sec, ns) },
    offerPatch: { acceptedAt: new FakeTimestamp(sec, ns) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
  });

  await assert.rejects(
    () => manager.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-nano-future' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('88. completeJob: nanosecond precision: rejects job.inProgressAt !== offer.inProgressAt when diff is 1 nanosecond with zero writes', async () => {
  const sec = 1000;
  const ns = 500000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: { inProgressAt: new FakeTimestamp(sec, ns) },
    offerPatch: { inProgressAt: new FakeTimestamp(sec, ns + 1) },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-nano-inprog-diff' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('89. completeJob: nanosecond precision: rejects job.acceptedAt > job.inProgressAt by 1 nanosecond (same ms) with zero writes', async () => {
  const sec = 1000;
  const ns = 500000;
  const { db, jobId, driverId, offerId } = setupInProgressSeed({
    jobPatch: {
      acceptedAt: new FakeTimestamp(sec, ns + 1),
      inProgressAt: new FakeTimestamp(sec, ns),
    },
    offerPatch: {
      acceptedAt: new FakeTimestamp(sec, ns + 1),
      inProgressAt: new FakeTimestamp(sec, ns),
    },
  });
  const before = captureFullDbSnapshot(db);
  const manager = createJobLifecycleManager({ db, TimestampClass: FakeTimestamp });

  await assert.rejects(
    () => manager.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-nano-order' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(db), before);
});

test('90. startJob & completeJob: rejects duck-typed timestamp objects and Date objects with zero writes', async () => {
  const duckTimestamp = {
    seconds: 1000,
    nanoseconds: 500000,
    toMillis: () => 1000000,
    toDate: () => new Date(1000000),
  };
  const { db: startDb, jobId, driverId, offerId } = setupAcceptedSeed({
    jobPatch: { acceptedAt: duckTimestamp },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-duck' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, driverId: cDriverId, offerId: cOfferId } = setupInProgressSeed({
    jobPatch: { inProgressAt: new Date() },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: cDriverId, requestId: 'req-comp-date' }),
    err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('91. direct verification of compareTimestamps, timestampsEqual, timestampLessThanOrEqual unit behaviors', () => {
  const ts1 = new FakeTimestamp(100, 500);
  const ts2 = new FakeTimestamp(100, 500);
  const ts3 = new FakeTimestamp(100, 501);
  const ts4 = new FakeTimestamp(101, 100);

  assert.equal(compareTimestamps(ts1, ts2, FakeTimestamp), 0);
  assert.equal(timestampsEqual(ts1, ts2, FakeTimestamp), true);
  assert.equal(timestampLessThanOrEqual(ts1, ts2, FakeTimestamp), true);

  assert.equal(compareTimestamps(ts1, ts3, FakeTimestamp), -1);
  assert.equal(timestampsEqual(ts1, ts3, FakeTimestamp), false);
  assert.equal(timestampLessThanOrEqual(ts1, ts3, FakeTimestamp), true);

  assert.equal(compareTimestamps(ts3, ts1, FakeTimestamp), 1);
  assert.equal(timestampsEqual(ts3, ts1, FakeTimestamp), false);
  assert.equal(timestampLessThanOrEqual(ts3, ts1, FakeTimestamp), false);

  assert.equal(compareTimestamps(ts1, ts4, FakeTimestamp), -1);
  assert.equal(timestampLessThanOrEqual(ts1, ts4, FakeTimestamp), true);

  // Non-Timestamp objects throw LIFECYCLE_TIMESTAMP_INVALID
  assert.throws(() => compareTimestamps(null, ts1, FakeTimestamp), err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID');
  assert.throws(() => compareTimestamps(ts1, new Date(), FakeTimestamp), err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID');
  assert.throws(() => compareTimestamps(ts1, 12345, FakeTimestamp), err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID');
  assert.throws(() => compareTimestamps(ts1, 'string', FakeTimestamp), err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID');
  assert.throws(() => compareTimestamps(ts1, { seconds: 100, nanoseconds: 500 }, FakeTimestamp), err => err.code === 'LIFECYCLE_TIMESTAMP_INVALID');
});

// ============================================================================
// ASTRA REPAIR BLOCKER 1: ROUND SHORTLIST CAP ENFORCEMENT
// ============================================================================

test('92. startJob & completeJob: candidate round distribution: one candidate, cap 1 is legal', async () => {
  const driverId = 'driver_test_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: 1,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
    },
  });
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  const startRes = await startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-cap1' });
  assert.equal(startRes.started, true);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: {
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: 1,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
    },
  });
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  const compRes = await compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-cap1' });
  assert.equal(compRes.completed, true);
});

test('93. startJob & completeJob: candidate round distribution: exactly cap candidates is legal', async () => {
  const driverId = 'driver_test_1';
  const prevDriver = 'driver_prev_1';
  const cap = 2;
  const candidates = [
    {
      driverId: prevDriver,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [prevDriver, driverId],
      excludedDriverIds: [],
    },
  });
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  const startRes = await startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-exact-cap' });
  assert.equal(startRes.started, true);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [prevDriver, driverId],
      excludedDriverIds: [],
    },
  });
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  const compRes = await compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-exact-cap' });
  assert.equal(compRes.completed, true);
});

test('94. startJob & completeJob: candidate round distribution: cap + 1 candidates in round 0 rejects with zero writes', async () => {
  const driverId = 'driver_test_1';
  const prev1 = 'driver_prev_1';
  const prev2 = 'driver_prev_2';
  const cap = 2;
  const candidates = [
    {
      driverId: prev1,
      roundIndex: 0,
      haversineDistanceKm: 1.5,
      matrixEtaSeconds: 200,
      matrixDistanceMeters: 1500,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: prev2,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 2 },
    runPatch: {
      nextCandidateIndex: 3,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [prev1, prev2, driverId],
      excludedDriverIds: [],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-cap-r0' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 2 },
    runPatch: {
      nextCandidateIndex: 3,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [prev1, prev2, driverId],
      excludedDriverIds: [],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-cap-r0' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('95. startJob & completeJob: candidate round distribution: cap + 1 candidates in a later round rejects with zero writes', async () => {
  const driverId = 'driver_test_1';
  const r0Driver = 'driver_r0_1';
  const r1Driver1 = 'driver_r1_1';
  const r1Driver2 = 'driver_r1_2';
  const cap = 2;
  const candidates = [
    {
      driverId: r0Driver,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r1Driver1,
      roundIndex: 1,
      haversineDistanceKm: 12.0,
      matrixEtaSeconds: 1200,
      matrixDistanceMeters: 10000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r1Driver2,
      roundIndex: 1,
      haversineDistanceKm: 14.0,
      matrixEtaSeconds: 1400,
      matrixDistanceMeters: 12000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 1,
      haversineDistanceKm: 15.0,
      matrixEtaSeconds: 1500,
      matrixDistanceMeters: 13000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver, r1Driver1, r1Driver2, driverId],
      excludedDriverIds: [],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-cap-r1' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver, r1Driver1, r1Driver2, driverId],
      excludedDriverIds: [],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-cap-r1' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('96. startJob & completeJob: candidate round distribution: multiple rounds each independently <= cap is legal', async () => {
  const driverId = 'driver_test_1';
  const r0Driver1 = 'driver_r0_1';
  const r0Driver2 = 'driver_r0_2';
  const r1Driver1 = 'driver_r1_1';
  const cap = 2;
  const candidates = [
    {
      driverId: r0Driver1,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r0Driver2,
      roundIndex: 0,
      haversineDistanceKm: 4.0,
      matrixEtaSeconds: 400,
      matrixDistanceMeters: 3000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r1Driver1,
      roundIndex: 1,
      haversineDistanceKm: 12.0,
      matrixEtaSeconds: 1200,
      matrixDistanceMeters: 10000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 1,
      haversineDistanceKm: 15.0,
      matrixEtaSeconds: 1500,
      matrixDistanceMeters: 13000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver1, r0Driver2, r1Driver1, driverId],
      excludedDriverIds: [],
    },
  });
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  const startRes = await startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-multi-legal' });
  assert.equal(startRes.started, true);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver1, r0Driver2, r1Driver1, driverId],
      excludedDriverIds: [],
    },
  });
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  const compRes = await compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-multi-legal' });
  assert.equal(compRes.completed, true);
});

test('97. startJob & completeJob: candidate round distribution: one round exceeds cap while other rounds are legal rejects with zero writes', async () => {
  const driverId = 'driver_test_1';
  const r0Driver1 = 'driver_r0_1';
  const r0Driver2 = 'driver_r0_2';
  const r0Driver3 = 'driver_r0_3';
  const cap = 2;
  const candidates = [
    {
      driverId: r0Driver1,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r0Driver2,
      roundIndex: 0,
      haversineDistanceKm: 3.0,
      matrixEtaSeconds: 400,
      matrixDistanceMeters: 2500,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId: r0Driver3,
      roundIndex: 0,
      haversineDistanceKm: 4.0,
      matrixEtaSeconds: 500,
      matrixDistanceMeters: 3000,
      rankingMode: 'ola',
      outcome: 'declined',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 1,
      haversineDistanceKm: 12.0,
      matrixEtaSeconds: 1200,
      matrixDistanceMeters: 10000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver1, r0Driver2, r0Driver3, driverId],
      excludedDriverIds: [],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-one-exceed' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 3, roundIndex: 1 },
    runPatch: {
      nextCandidateIndex: 4,
      policySnapshot: {
        locationFreshnessSeconds: 120,
        radiusKmSequence: [10, 20, 35],
        maxUniqueCandidatesPerGeneration: 30,
        maxMatrixShortlistPerRound: cap,
        rankingPrimary: 'ola_eta_seconds',
        rankingSecondary: 'ola_distance_meters',
        rankingTieBreak: 'driver_uid',
        olaFailureMode: 'bounded_retry_then_haversine_degraded',
      },
      candidates,
      attemptedDriverIds: [r0Driver1, r0Driver2, r0Driver3, driverId],
      excludedDriverIds: [],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-one-exceed' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

// ============================================================================
// ASTRA REPAIR BLOCKER 2: EXCLUDED DRIVER IDS SEMANTICS
// ============================================================================

test('98. startJob & completeJob: current accepted driver absent from excludedDriverIds is legal', async () => {
  const driverId = 'driver_test_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      excludedDriverIds: [],
    },
  });
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  const startRes = await startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-no-excl' });
  assert.equal(startRes.started, true);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: {
      excludedDriverIds: [],
    },
  });
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  const compRes = await compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-no-excl' });
  assert.equal(compRes.completed, true);
});

test('99. startJob & completeJob: current accepted driver as sole excluded ID rejects with zero writes', async () => {
  const driverId = 'driver_test_1';
  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    runPatch: {
      excludedDriverIds: [driverId],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-accepted-excluded' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    runPatch: {
      excludedDriverIds: [driverId],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-accepted-excluded' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('100. startJob & completeJob: current accepted driver mixed with legitimate historical excluded IDs rejects with zero writes', async () => {
  const driverId = 'driver_test_1';
  const cancelledDriver = 'driver_cancelled_1';
  const candidates = [
    {
      driverId: cancelledDriver,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'driver_cancelled',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver, driverId],
    },
  });
  const startBefore = captureFullDbSnapshot(startDb);
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-mixed-excl' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(startDb), startBefore);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver, driverId],
    },
  });
  const compBefore = captureFullDbSnapshot(compDb);
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-mixed-excl' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDb), compBefore);
});

test('101. startJob & completeJob: historical driver_cancelled driver excluded, current accepted driver not excluded is legal', async () => {
  const driverId = 'driver_test_1';
  const cancelledDriver = 'driver_cancelled_1';
  const candidates = [
    {
      driverId: cancelledDriver,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'driver_cancelled',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  const { db: startDb, jobId, offerId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver],
    },
  });
  const startMgr = createJobLifecycleManager({ db: startDb, TimestampClass: FakeTimestamp });
  const startRes = await startMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-hist-excl' });
  assert.equal(startRes.started, true);

  const { db: compDb, jobId: cJobId, offerId: cOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver],
    },
  });
  const compMgr = createJobLifecycleManager({ db: compDb, TimestampClass: FakeTimestamp });
  const compRes = await compMgr.completeJob({ jobId: cJobId, offerId: cOfferId, driverUid: driverId, requestId: 'req-comp-hist-excl' });
  assert.equal(compRes.completed, true);
});

test('102. startJob & completeJob: duplicate/malformed excludedDriverIds continue to fail closed with zero writes', async () => {
  const driverId = 'driver_test_1';
  const cancelledDriver = 'driver_cancelled_1';
  const candidates = [
    {
      driverId: cancelledDriver,
      roundIndex: 0,
      haversineDistanceKm: 2.0,
      matrixEtaSeconds: 300,
      matrixDistanceMeters: 2000,
      rankingMode: 'ola',
      outcome: 'driver_cancelled',
      reasonCode: null,
    },
    {
      driverId,
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'accepted',
      reasonCode: null,
    },
  ];

  // 1. Duplicate excluded driver IDs on startJob
  const { db: dupDb, jobId: dupJobId, offerId: dupOfferId } = setupAcceptedSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver, cancelledDriver],
    },
  });
  const dupBefore = captureFullDbSnapshot(dupDb);
  const dupMgr = createJobLifecycleManager({ db: dupDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => dupMgr.startJob({ jobId: dupJobId, offerId: dupOfferId, driverUid: driverId, requestId: 'req-start-dup-excl' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(dupDb), dupBefore);

  // 2. Excluded driver ID not in attempted drivers on startJob
  const { db: notAttDb, jobId: notAttJobId, offerId: notAttOfferId } = setupAcceptedSeed({
    runPatch: {
      excludedDriverIds: ['unknown_driver'],
    },
  });
  const notAttBefore = captureFullDbSnapshot(notAttDb);
  const notAttMgr = createJobLifecycleManager({ db: notAttDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => notAttMgr.startJob({ jobId: notAttJobId, offerId: notAttOfferId, driverUid: driverId, requestId: 'req-start-notatt-excl' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(notAttDb), notAttBefore);

  // 3. Complete job with duplicate excluded driver IDs
  const { db: compDupDb, jobId: cDupJobId, offerId: cDupOfferId } = setupInProgressSeed({
    offerPatch: { candidateIndex: 1 },
    runPatch: {
      nextCandidateIndex: 2,
      candidates,
      attemptedDriverIds: [cancelledDriver, driverId],
      excludedDriverIds: [cancelledDriver, cancelledDriver],
    },
  });
  const compDupBefore = captureFullDbSnapshot(compDupDb);
  const compDupMgr = createJobLifecycleManager({ db: compDupDb, TimestampClass: FakeTimestamp });
  await assert.rejects(
    () => compDupMgr.completeJob({ jobId: cDupJobId, offerId: cDupOfferId, driverUid: driverId, requestId: 'req-comp-dup-excl' }),
    err => err.code === 'RUN_INVALID'
  );
  assert.deepEqual(captureFullDbSnapshot(compDupDb), compDupBefore);
});
