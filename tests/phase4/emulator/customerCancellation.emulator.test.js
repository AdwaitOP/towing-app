'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint, FieldValue } = require('firebase-admin/firestore');
const {
  createCustomerCancellationManager,
  shouldProcessCustomerCancellation,
} = require('../../../firebase/functions/src/dispatch/customerCancellation');
const { createAcceptJobManager } = require('../../../firebase/functions/src/dispatch/acceptJob');
const { createJobLifecycleManager } = require('../../../firebase/functions/src/dispatch/jobLifecycle');
const { paidJob, config, driver } = require('../fixtures');
const { DispatchError } = require('../../../firebase/functions/src/dispatch/dispatchValidation');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage7-cancellation-test';
const app = initializeApp({ projectId: project }, 'stage7-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = (jobId, gen = 1) => db.doc('jobs/' + jobId + '/dispatch_runs/' + gen);
const driverRef = id => db.doc('drivers/' + id);
const debitLedgerRef = (jobId, offerId) => db.doc('wallet_entries/commission_debit:' + jobId + ':' + offerId);
const creditLedgerRef = (jobId, offerId) => db.doc('wallet_entries/customer_cancel_credit:' + jobId + ':' + offerId);
const acceptedOutboxRef = (jobId, offerId) => db.doc('notification_outbox/job_accepted:' + jobId + ':' + offerId);
const inProgressOutboxRef = jobId => db.doc('notification_outbox/job_in_progress:' + jobId);
const cancelledOutboxRef = jobId => db.doc('notification_outbox/job_cancelled_customer:' + jobId);

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
    ...patch,
  });
  await driverRef(id).set(d);
  return d;
}

async function seedOfferedJob({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  generation = 1,
  requestedAt = null,
} = {}) {
  const offeredAt = T.fromMillis(clock - 5000);
  const expiresAt = T.fromMillis(clock + 40000);
  const cancelReqAt = requestedAt || T.fromMillis(clock - 1000);

  const j = paidJob(T, clock, {
    status: 'offered',
    dispatchState: 'offered',
    offeredTo: driverId,
    currentOfferId: offerId,
    offeredAt,
    offerExpiresAt: expiresAt,
    acceptedAt: null,
    inProgressAt: null,
    completedAt: null,
    dispatchGeneration: generation,
    dispatchRunId: String(generation),
    stateVersion: 1,
    driverCommissionPaise: 5000,
    commissionDebitEntryId: null,
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: cancelReqAt,
  });

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
    timeoutTaskState: 'not_required',
    acceptRequestId: null,
    cancellationPolicySnapshot: null,
    pickupCoords: j.pickupCoords,
    destCoords: j.destCoords,
    requestedTruckType: j.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: 250000,
    driverCommissionPaise: 5000,
    createdAt: offeredAt,
    updatedAt: offeredAt,
  };

  const r = {
    jobId,
    generation,
    policyVersion: 1,
    status: 'active',
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
  };

  await seedDriver(driverId, { activeOfferId: offerId, activeJobId: null, walletBalance: 20000 });
  await jobRef(jobId).set(j);
  await offerRef(offerId).set(o);
  await runRef(jobId, generation).set(r);

  return { jobId, driverId, offerId, generation };
}

async function seedAcceptedJob({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  generation = 1,
  requestedAt = null,
} = {}) {
  const acceptedAt = T.fromMillis(clock - 5000);
  const cancelReqAt = requestedAt || T.fromMillis(clock - 1000);

  const j = paidJob(T, clock, {
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
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: cancelReqAt,
  });

  const o = {
    jobId,
    driverId,
    dispatchGeneration: generation,
    candidateIndex: 0,
    roundIndex: 0,
    status: 'accepted',
    offeredAt: T.fromMillis(clock - 10000),
    expiresAt: T.fromMillis(clock + 30000),
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'not_required',
    acceptRequestId: null,
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
    estimatedFarePaise: 250000,
    driverCommissionPaise: 5000,
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: acceptedAt,
  };

  const r = {
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
    createdAt: T.fromMillis(clock - 10000),
    updatedAt: acceptedAt,
  };

  const ledger = {
    operationId: 'commission_debit:' + jobId + ':' + offerId,
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
    sourceRequestId: null,
    sourceType: 'driver',
    actorUid: driverId,
    createdAt: acceptedAt,
  };

  const outbox = {
    eventId: 'job_accepted:' + jobId + ':' + offerId,
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
  };

  await seedDriver(driverId, { activeJobId: jobId, activeOfferId: null, walletBalance: 20000 });
  await jobRef(jobId).set(j);
  await offerRef(offerId).set(o);
  await runRef(jobId, generation).set(r);
  await debitLedgerRef(jobId, offerId).set(ledger);
  await acceptedOutboxRef(jobId, offerId).set(outbox);

  return { jobId, driverId, offerId, generation, acceptedAt };
}

async function seedInProgressJob(opts = {}) {
  const seed = await seedAcceptedJob(opts);
  const inProgressAt = T.fromMillis(clock - 2000);

  await jobRef(seed.jobId).update({
    status: 'in_progress',
    inProgressAt,
    updatedAt: inProgressAt,
  });
  await offerRef(seed.offerId).update({
    status: 'in_progress',
    inProgressAt,
    updatedAt: inProgressAt,
  });

  const inProgOutbox = {
    eventId: 'job_in_progress:' + seed.jobId,
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: seed.jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + seed.jobId,
    payloadVersion: 1,
    payload: {
      jobId: seed.jobId,
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
  };
  await inProgressOutboxRef(seed.jobId).set(inProgOutbox);

  return { ...seed, inProgressAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMULATOR TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('emulator: resolves offered customer cancellation (pre-assignment)', async () => {
  const seed = await seedOfferedJob();
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.status, 'cancelled_customer');
  assert.equal(result.refundPaise, 0);

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.currentOfferId, seed.offerId);
  assert.equal(j.cancellationResolutionState, 'resolved');
  assert.equal(j.assignedDriver, null);

  const o = await read(offerRef(seed.offerId));
  assert.equal(o.status, 'cancelled_customer');
  assert.equal(o.resolutionReason, 'customer_cancelled');

  const r = await read(runRef(seed.jobId));
  assert.equal(r.status, 'cancelled_customer');
  assert.equal(r.currentOfferId, seed.offerId);
  assert.ok(r.finalizedAt);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeOfferId, null);
  assert.equal(d.activeJobId, null);
  assert.equal(d.walletBalance, 20000);

  const outbox = await read(cancelledOutboxRef(seed.jobId));
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_cancelled_customer');
  assert.equal(outbox.payload.jobStatus, 'cancelled_customer');
});

test('emulator: resolves accepted customer cancellation (reverses commission 100%)', async () => {
  const seed = await seedAcceptedJob();
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.refundPaise, 5000);

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.currentOfferId, seed.offerId);
  assert.equal(j.cancellationResolutionState, 'resolved');
  assert.equal(j.assignedDriver, seed.driverId);

  const r = await read(runRef(seed.jobId));
  assert.equal(r.status, 'cancelled_customer');
  assert.equal(r.currentOfferId, seed.offerId);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeJobId, null);
  assert.equal(d.walletBalance, 25000); // 20000 + 5000

  const creditEntry = await read(creditLedgerRef(seed.jobId, seed.offerId));
  assert.ok(creditEntry);
  assert.equal(creditEntry.type, 'customer_cancel_credit');
  assert.equal(creditEntry.deltaPaise, 5000);
  assert.equal(creditEntry.balanceBeforePaise, 20000);
  assert.equal(creditEntry.balanceAfterPaise, 25000);
  assert.equal(creditEntry.sourceType, 'customer');
});

test('emulator: resolves in_progress customer cancellation', async () => {
  const seed = await seedInProgressJob();
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.refundPaise, 5000);

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.currentOfferId, seed.offerId);

  const r = await read(runRef(seed.jobId));
  assert.equal(r.status, 'cancelled_customer');
  assert.equal(r.currentOfferId, seed.offerId);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeJobId, null);
  assert.equal(d.walletBalance, 25000);

  const creditEntry = await read(creditLedgerRef(seed.jobId, seed.offerId));
  assert.ok(creditEntry);
  assert.equal(creditEntry.deltaPaise, 5000);
});

test('emulator: concurrent duplicate resolver transactions are safely idempotent', async () => {
  const seed = await seedAcceptedJob();
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  const [res1, res2] = await Promise.all([
    manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    manager.resolveCustomerCancellation({ jobId: seed.jobId }),
  ]);

  assert.equal(res1.resolved, true);
  assert.equal(res2.resolved, true);

  // Exactly one credit entry
  const creditEntry = await read(creditLedgerRef(seed.jobId, seed.offerId));
  assert.ok(creditEntry);

  // Driver credited exactly once
  const d = await read(driverRef(seed.driverId));
  assert.equal(d.walletBalance, 25000);
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL RACES A, B, C
// ─────────────────────────────────────────────────────────────────────────────

test('emulator Race A: Customer Cancellation vs Accept Job (order 1: cancel resolved first)', async () => {
  const seed = await seedOfferedJob();
  const cancelManager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });

  const cancelResult = await cancelManager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(cancelResult.resolved, true);

  await assert.rejects(
    () => acceptManager.acceptJob({ jobId: seed.jobId, offerId: seed.offerId, driverUid: seed.driverId }),
    err => err instanceof DispatchError && (err.code === 'CANCELLATION_PRECEDENCE' || err.code === 'OFFER_NOT_OFFERED' || err.code === 'JOB_NOT_OFFERED')
  );

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.assignedDriver, null);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeOfferId, null);
  assert.equal(d.walletBalance, 20000);
});

test('emulator Race A: Customer Cancellation vs Accept Job (concurrent race)', async () => {
  const seed = await seedOfferedJob();
  const cancelManager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });

  await Promise.allSettled([
    cancelManager.resolveCustomerCancellation({ jobId: seed.jobId }),
    acceptManager.acceptJob({ jobId: seed.jobId, offerId: seed.offerId, driverUid: seed.driverId }),
  ]);

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.cancellationResolutionState, 'resolved');

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeOfferId, null);
  assert.equal(d.activeJobId, null);
  assert.equal(d.walletBalance, 20000); // restored or unchanged

  const outbox = await read(cancelledOutboxRef(seed.jobId));
  assert.ok(outbox);
});

test('emulator Race B: Customer Cancellation vs startJob (concurrent race on accepted job)', async () => {
  const seed = await seedAcceptedJob();
  const cancelManager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const lifecycleManager = createJobLifecycleManager({ db, TimestampClass: T, now });

  await Promise.allSettled([
    cancelManager.resolveCustomerCancellation({ jobId: seed.jobId }),
    lifecycleManager.startJob({ jobId: seed.jobId, offerId: seed.offerId, driverUid: seed.driverId, requestId: 'req_start_race_b' }),
  ]);

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');
  assert.equal(j.cancellationResolutionState, 'resolved');
  assert.equal(j.currentOfferId, seed.offerId);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeJobId, null);
  assert.equal(d.activeOfferId, null);
  assert.equal(d.walletBalance, 25000); // reversed

  const creditEntry = await read(creditLedgerRef(seed.jobId, seed.offerId));
  assert.ok(creditEntry);
  assert.equal(creditEntry.deltaPaise, 5000);
});

test('emulator Race C: Customer Cancellation vs completeJob (order 1: complete runs first)', async () => {
  const seed = await seedInProgressJob();
  const cancelManager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const lifecycleManager = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Unmark cancellation before driver completes (driver completes normal job)
  await jobRef(seed.jobId).update({
    cancelledBy: null,
    cancellationReason: null,
    cancellationResolutionState: 'none',
    cancellationRequestedAt: null,
  });

  // First complete the job
  const completeRes = await lifecycleManager.completeJob({
    jobId: seed.jobId,
    offerId: seed.offerId,
    driverUid: seed.driverId,
    requestId: 'req_complete_race_c_1',
  });
  assert.equal(completeRes.completed, true);

  // Customer cancellation attempt on completed job must fail closed
  await jobRef(seed.jobId).update({
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: T.fromMillis(clock),
  });

  await assert.rejects(
    () => cancelManager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'completed');
  assert.ok(j.completedAt);

  const d = await read(driverRef(seed.driverId));
  assert.equal(d.activeJobId, null);
  assert.equal(d.walletBalance, 20000); // no refund because job completed
});

test('emulator Race C: Customer Cancellation vs completeJob (concurrent race)', async () => {
  const seed = await seedInProgressJob();
  const cancelManager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const lifecycleManager = createJobLifecycleManager({ db, TimestampClass: T, now });

  await Promise.allSettled([
    cancelManager.resolveCustomerCancellation({ jobId: seed.jobId }),
    lifecycleManager.completeJob({
      jobId: seed.jobId,
      offerId: seed.offerId,
      driverUid: seed.driverId,
      requestId: 'req_complete_race_c_2',
    }),
  ]);

  const j = await read(jobRef(seed.jobId));
  const d = await read(driverRef(seed.driverId));

  // Deterministic invariant: either cancelled_customer or completed
  assert.ok(['cancelled_customer', 'completed'].includes(j.status));
  assert.equal(d.activeJobId, null);

  if (j.status === 'cancelled_customer') {
    assert.equal(d.walletBalance, 25000);
    const credit = await read(creditLedgerRef(seed.jobId, seed.offerId));
    assert.ok(credit);
  } else {
    assert.equal(d.walletBalance, 20000);
    const credit = await exists(creditLedgerRef(seed.jobId, seed.offerId));
    assert.equal(credit, false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILER & OUTBOX MATRIX
// ─────────────────────────────────────────────────────────────────────────────

test('emulator: reconcileCustomerCancellations sweeps multiple jobs in order', async () => {
  const seed1 = await seedOfferedJob({ jobId: 'job_sweep_1', driverId: 'driver_1', offerId: 'offer_1', requestedAt: T.fromMillis(clock - 5000) });
  const seed2 = await seedAcceptedJob({ jobId: 'job_sweep_2', driverId: 'driver_2', offerId: 'offer_2', requestedAt: T.fromMillis(clock - 3000) });

  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const sweep = await manager.reconcileCustomerCancellations({ batchSize: 10 });

  assert.equal(sweep.discovered, 2);
  assert.equal(sweep.resolved, 2);
  assert.equal(sweep.failed, 0);

  const j1 = await read(jobRef(seed1.jobId));
  const j2 = await read(jobRef(seed2.jobId));
  assert.equal(j1.status, 'cancelled_customer');
  assert.equal(j2.status, 'cancelled_customer');
});

test('emulator: reconcileCustomerCancellations isolates poisoned job and succeeds on healthy job', async () => {
  // Healthy job
  const healthy = await seedAcceptedJob({ jobId: 'job_healthy', driverId: 'driver_h', offerId: 'offer_h' });

  // Poisoned job: delete its debit ledger so resolver fails closed
  const poisoned = await seedAcceptedJob({ jobId: 'job_poison', driverId: 'driver_p', offerId: 'offer_p' });
  await debitLedgerRef(poisoned.jobId, poisoned.offerId).delete();

  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  await assert.rejects(
    () => manager.reconcileCustomerCancellations({ batchSize: 10 }),
    err => err instanceof DispatchError && err.code === 'RECONCILIATION_INCOMPLETE'
  );

  // Healthy job was still resolved!
  const jH = await read(jobRef(healthy.jobId));
  assert.equal(jH.status, 'cancelled_customer');

  // Poisoned job remains in pending state
  const jP = await read(jobRef(poisoned.jobId));
  assert.equal(jP.status, 'accepted');
  assert.equal(jP.cancellationResolutionState, 'pending');
});

test('emulator: outbox state matrix: customer cancellation resolves across all prior outbox states', async () => {
  const statePatches = {
    pending: {},
    in_progress: {
      state: 'in_progress',
      attemptCount: 1,
      ownerToken: 'worker_token_1',
      leaseUntil: T.fromMillis(clock + 30000),
    },
    retry_wait: {
      state: 'retry_wait',
      attemptCount: 1,
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: T.fromMillis(clock + 30000),
      lastErrorCode: 'provider_unavailable',
    },
    sent: {
      state: 'sent',
      attemptCount: 1,
      ownerToken: null,
      leaseUntil: null,
      sentAt: T.fromMillis(clock - 1000),
      providerMessageId: 'prov_msg_123',
      lastErrorCode: null,
    },
    failed_terminal: {
      state: 'failed_terminal',
      attemptCount: 5,
      ownerToken: null,
      leaseUntil: null,
      lastErrorCode: 'internal_error',
    },
  };

  for (const [state, patch] of Object.entries(statePatches)) {
    const seed = await seedAcceptedJob({
      jobId: 'job_outbox_' + state,
      driverId: 'driver_outbox_' + state,
      offerId: 'offer_outbox_' + state,
    });
    if (Object.keys(patch).length > 0) {
      await acceptedOutboxRef(seed.jobId, seed.offerId).update(patch);
    }

    const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });
    const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
    assert.equal(res.resolved, true);

    const outbox = await read(cancelledOutboxRef(seed.jobId));
    assert.ok(outbox);
    assert.equal(outbox.state, 'pending');
    assert.equal(outbox.eventType, 'job_cancelled_customer');
  }
});

test('emulator: Blocker 1: missing job.completedAt rejects with zero writes', async () => {
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });

  // 1. Offered
  const seedOff = await seedOfferedJob({ jobId: 'job_b1_em_off', driverId: 'driver_b1_em_off', offerId: 'offer_b1_em_off' });
  await jobRef(seedOff.jobId).update({ completedAt: FieldValue.delete() });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seedOff.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );
  assert.equal((await read(jobRef(seedOff.jobId))).status, 'offered');
  assert.equal(await exists(cancelledOutboxRef(seedOff.jobId)), false);

  // 2. Accepted
  const seedAcc = await seedAcceptedJob({ jobId: 'job_b1_em_acc', driverId: 'driver_b1_em_acc', offerId: 'offer_b1_em_acc' });
  await jobRef(seedAcc.jobId).update({ completedAt: FieldValue.delete() });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seedAcc.jobId }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  assert.equal((await read(jobRef(seedAcc.jobId))).status, 'accepted');
  assert.equal((await read(driverRef(seedAcc.driverId))).walletBalance, 20000);
  assert.equal(await exists(creditLedgerRef(seedAcc.jobId, seedAcc.offerId)), false);
  assert.equal(await exists(cancelledOutboxRef(seedAcc.jobId)), false);

  // 3. In Progress
  const seedProg = await seedInProgressJob({ jobId: 'job_b1_em_prog', driverId: 'driver_b1_em_prog', offerId: 'offer_b1_em_prog' });
  await jobRef(seedProg.jobId).update({ completedAt: FieldValue.delete() });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seedProg.jobId }),
    err => err instanceof DispatchError && err.code === 'IN_PROGRESS_CONFLICT'
  );
  assert.equal((await read(jobRef(seedProg.jobId))).status, 'in_progress');
  assert.equal((await read(driverRef(seedProg.driverId))).walletBalance, 20000);
  assert.equal(await exists(creditLedgerRef(seedProg.jobId, seedProg.offerId)), false);
});

test('emulator: Blocker 2: impossible accepted expiry rejects with zero writes', async () => {
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const seed = await seedAcceptedJob({ jobId: 'job_b2_em_acc', driverId: 'driver_b2_em_acc', offerId: 'offer_b2_em_acc' });

  // Corrupt expiresAt so offer expired before acceptedAt (clock - 20000 < clock - 5000)
  await offerRef(seed.offerId).update({ expiresAt: T.fromMillis(clock - 20000) });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.equal((await read(jobRef(seed.jobId))).status, 'accepted');
  assert.equal((await read(driverRef(seed.driverId))).walletBalance, 20000);
  assert.equal(await exists(creditLedgerRef(seed.jobId, seed.offerId)), false);
});

test('emulator: Blocker 2: legitimate customer cancellation after offer expiry succeeds on OFFERED job', async () => {
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const offeredAt = T.fromMillis(clock - 60000);
  const expiresAt = T.fromMillis(clock - 15000);
  const cancelReqAt = T.fromMillis(clock - 5000);

  const seed = await seedOfferedJob({
    jobId: 'job_b2_em_legal',
    driverId: 'driver_b2_em_legal',
    offerId: 'offer_b2_em_legal',
    requestedAt: cancelReqAt,
  });
  await jobRef(seed.jobId).update({ offeredAt, offerExpiresAt: expiresAt });
  await offerRef(seed.offerId).update({ offeredAt, expiresAt });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);
  assert.equal(res.status, 'cancelled_customer');

  const j = await read(jobRef(seed.jobId));
  assert.equal(j.status, 'cancelled_customer');
  assert.equal(j.dispatchState, 'closed');

  // Terminal retry also succeeds
  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

test('emulator: Blocker 3: original debit request attribution validates matching requestId and rejects mismatch', async () => {
  const manager = createCustomerCancellationManager({ db, TimestampClass: T, now });
  const reqId = 'req_em_attribution_123';
  const seed = await seedAcceptedJob({
    jobId: 'job_b3_em_attr',
    driverId: 'driver_b3_em_attr',
    offerId: 'offer_b3_em_attr',
  });

  // Seed processed_requests receipt and matching request IDs
  const payloadHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ jobId: seed.jobId, offerId: seed.offerId }), 'utf8').digest('hex');
  await db.doc('processed_requests/' + reqId).set({
    requestId: reqId,
    status: 'completed',
    type: 'phase4_client_mutation',
    actorUid: seed.driverId,
    operation: 'accept',
    resourceId: seed.jobId + ':' + seed.offerId,
    payloadHash,
    result: {
      accepted: true,
      jobId: seed.jobId,
      offerId: seed.offerId,
      driverId: seed.driverId,
    },
    processedAt: seed.acceptedAt,
    claimedAt: seed.acceptedAt,
    leaseUntil: null,
    ownerToken: null,
  });

  await offerRef(seed.offerId).update({ acceptRequestId: reqId });
  await debitLedgerRef(seed.jobId, seed.offerId).update({ sourceRequestId: reqId });

  // Pre-resolution succeeds
  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  // Terminal retry with matching request ID succeeds
  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);

  // Corrupt debit sourceRequestId in terminal state
  await debitLedgerRef(seed.jobId, seed.offerId).update({ sourceRequestId: 'wrong-request-id' });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('emulator: Blocker 4: reactive trigger handles real Firestore snapshot transitions', async () => {
  const docRef = db.doc('jobs/job_b4_trigger_test');

  // Seed with INVALID marker (pending, but cancelledBy and cancellationReason are null)
  await docRef.set({
    status: 'offered',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: T.fromMillis(clock),
    cancelledBy: null,
    cancellationReason: null,
    updatedAt: T.fromMillis(clock),
  });
  const beforeSnap = await docRef.get();

  // Update to VALID marker
  await docRef.update({
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    updatedAt: T.fromMillis(clock + 100),
  });
  const afterSnap = await docRef.get();

  // Invalid -> Valid transition: reactive trigger fires (returns true)
  assert.equal(shouldProcessCustomerCancellation({ data: { before: beforeSnap, after: afterSnap } }, { TimestampClass: T }), true);

  // Valid -> Valid with only updatedAt changed: reactive trigger suppresses (returns false)
  await docRef.update({
    updatedAt: T.fromMillis(clock + 200),
  });
  const afterSnap2 = await docRef.get();
  assert.equal(shouldProcessCustomerCancellation({ data: { before: afterSnap, after: afterSnap2 } }, { TimestampClass: T }), false);
});
