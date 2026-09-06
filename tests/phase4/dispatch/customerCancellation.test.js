'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { GeoPoint } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createCustomerCancellationManager,
  getDefaultCustomerCancellationManager,
  shouldProcessCustomerCancellation,
} = require('../../../firebase/functions/src/dispatch/customerCancellation');
const {
  DispatchError,
  timestampsEqual,
  exactKeys,
  OFFER_EXACT_KEYS,
  WALLET_EXACT_KEYS,
} = require('../../../firebase/functions/src/dispatch/dispatchValidation');
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

function setupOfferedSeed({
  nowMs = 1000000,
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
} = {}) {
  const jobId = 'job_test_1';
  const driverId = 'driver_test_1';
  const generation = 1;
  const offerId = 'offer_test_1';
  const offeredAt = FakeTimestamp.fromMillis(nowMs - 5000);
  const offerExpiresAt = FakeTimestamp.fromMillis(nowMs + 40000);
  const requestedAt = FakeTimestamp.fromMillis(nowMs - 1000);

  const job = paidJob(FakeTimestamp, nowMs, {
    status: 'offered',
    dispatchState: 'offered',
    assignedDriver: null,
    currentOfferId: offerId,
    offeredTo: driverId,
    offeredAt,
    offerExpiresAt,
    acceptedAt: null,
    inProgressAt: null,
    completedAt: null,
    dispatchGeneration: generation,
    dispatchRunId: String(generation),
    stateVersion: 0,
    driverCommissionPaise: 5000,
    commissionDebitEntryId: null,
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: requestedAt,
    cancellationResolvedAt: null,
    cancelledAt: null,
    refundRequestId: null,
    refundState: 'none',
    refundNextAttemptAt: null,
    razorpayRefundId: null,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    ...jobPatch,
  });

  const driverDoc = driver(FakeTimestamp, nowMs, {
    activeOfferId: offerId,
    activeJobId: null,
    walletBalance: 20000,
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
    expiresAt: offerExpiresAt,
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt: null,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'not_required',
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

  const run = {
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
    ...runPatch,
  };

  const db = new FakeFirestore();
  db.data.jobs = { [jobId]: job };
  db.data.drivers = { [driverId]: driverDoc };
  db.data.job_offers = { [offerId]: offer };
  db.data['jobs/' + jobId + '/dispatch_runs'] = { [String(generation)]: run };
  db.data.wallet_entries = {};
  db.data.notification_outbox = {};

  return { db, jobId, driverId, offerId, generation, nowMs };
}

function setupAcceptedSeed({
  nowMs = 1000000,
  jobPatch = {},
  offerPatch = {},
  driverPatch = {},
  runPatch = {},
  ledgerPatch = {},
  outboxPatch = {},
} = {}) {
  const jobId = 'job_test_1';
  const driverId = 'driver_test_1';
  const generation = 1;
  const offerId = 'offer_test_1';
  const acceptedAt = FakeTimestamp.fromMillis(nowMs - 5000);
  const requestedAt = FakeTimestamp.fromMillis(nowMs - 1000);

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
    cancelledBy: 'customer',
    cancellationReason: 'customer_requested',
    cancellationResolutionState: 'pending',
    cancellationRequestedAt: requestedAt,
    cancellationResolvedAt: null,
    cancelledAt: null,
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
    offeredAt: FakeTimestamp.fromMillis(nowMs - 10000),
    expiresAt: FakeTimestamp.fromMillis(nowMs + 30000),
    resolvedAt: null,
    resolutionReason: null,
    acceptedAt,
    inProgressAt: null,
    completedAt: null,
    timeoutTaskId: null,
    timeoutTaskState: 'not_required',
    acceptRequestId: null,
    cancellationPolicySnapshot: policySnapshot,
    pickupCoords: job.pickupCoords,
    destCoords: job.destCoords,
    requestedTruckType: job.requestedTruckType,
    pickupRoutedDistanceMeters: 5000,
    pickupEtaSeconds: 600,
    estimatedFarePaise: 250000,
    driverCommissionPaise: 5000,
    createdAt: FakeTimestamp.fromMillis(nowMs - 10000),
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
    createdAt: FakeTimestamp.fromMillis(nowMs - 10000),
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
    sourceRequestId: null,
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
  db.data.drivers = { [driverId]: driverDoc };
  db.data.job_offers = { [offerId]: offer };
  db.data['jobs/' + jobId + '/dispatch_runs'] = { [String(generation)]: run };
  db.data.wallet_entries = { [ledgerId]: ledger };
  db.data.notification_outbox = { [acceptedOutboxId]: acceptedOutbox };

  return { db, jobId, driverId, offerId, generation, nowMs, acceptedAt };
}

function setupInProgressSeed(opts = {}) {
  const seed = setupAcceptedSeed({
    ...opts,
    nowMs: opts.nowMs || 1000000,
    jobPatch: {
      status: 'in_progress',
      inProgressAt: FakeTimestamp.fromMillis((opts.nowMs || 1000000) - 3000),
      ...opts.jobPatch,
    },
    offerPatch: {
      status: 'in_progress',
      inProgressAt: FakeTimestamp.fromMillis((opts.nowMs || 1000000) - 3000),
      ...opts.offerPatch,
    },
  });

  const inProgressAt = FakeTimestamp.fromMillis(seed.nowMs - 3000);
  const inProgressOutboxId = 'job_in_progress:' + seed.jobId;
  seed.db.data.notification_outbox[inProgressOutboxId] = {
    eventId: inProgressOutboxId,
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

  return { ...seed, inProgressAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ATOMIC LIFECYCLE RESOLUTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('resolves customer cancellation on offered job (pre-assignment)', async () => {
  const nowMs = 1000000;
  const seed = setupOfferedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.jobId, seed.jobId);
  assert.equal(result.offerId, seed.offerId);
  assert.equal(result.driverId, seed.driverId);
  assert.equal(result.previousStatus, 'offered');
  assert.equal(result.status, 'cancelled_customer');
  assert.equal(result.refundPaise, 0);

  // Assert Job
  const job = seed.db.data.jobs[seed.jobId];
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.offeredTo, null);
  assert.equal(job.currentOfferId, seed.offerId);
  assert.equal(job.offeredAt, null);
  assert.equal(job.offerExpiresAt, null);
  assert.equal(job.assignedDriver, null);
  assert.equal(job.cancellationResolutionState, 'resolved');
  assert.ok(job.cancellationResolvedAt);
  assert.ok(job.cancelledAt);
  assert.ok(timestampsEqual(job.cancellationResolvedAt, job.cancelledAt, FakeTimestamp));
  assert.equal(job.stateVersion, 1);

  // Assert Offer
  const offer = seed.db.data.job_offers[seed.offerId];
  assert.equal(offer.status, 'cancelled_customer');
  assert.ok(offer.resolvedAt);
  assert.equal(offer.resolutionReason, 'customer_cancelled');
  assert.equal(exactKeys(offer, OFFER_EXACT_KEYS), true);

  // Assert Run
  const run = seed.db.data['jobs/' + seed.jobId + '/dispatch_runs'][String(seed.generation)];
  assert.equal(run.status, 'cancelled_customer');
  assert.equal(run.currentOfferId, seed.offerId);
  assert.ok(run.finalizedAt);

  // Assert Driver
  const driverDoc = seed.db.data.drivers[seed.driverId];
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.walletBalance, 20000); // untouched

  // Assert zero wallet entries
  assert.equal(Object.keys(seed.db.data.wallet_entries).length, 0);

  // Assert Outbox
  const outbox = seed.db.data.notification_outbox['job_cancelled_customer:' + seed.jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_cancelled_customer');
  assert.equal(outbox.jobStatus, undefined); // payload has status
  assert.equal(outbox.payload.jobStatus, 'cancelled_customer');
  assert.equal(outbox.payload.refundAmountPaise, null);
  assert.equal(outbox.state, 'pending');
});

test('resolves customer cancellation on accepted job (assigned)', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.jobId, seed.jobId);
  assert.equal(result.offerId, seed.offerId);
  assert.equal(result.driverId, seed.driverId);
  assert.equal(result.previousStatus, 'accepted');
  assert.equal(result.status, 'cancelled_customer');
  assert.equal(result.refundPaise, 5000);
  assert.equal(result.reversalCreditEntryId, 'customer_cancel_credit:' + seed.jobId + ':' + seed.offerId);

  // Assert Job
  const job = seed.db.data.jobs[seed.jobId];
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.assignedDriver, seed.driverId); // preserved
  assert.equal(job.commissionDebitEntryId, 'commission_debit:' + seed.jobId + ':' + seed.offerId); // preserved
  assert.equal(job.currentOfferId, seed.offerId);
  assert.equal(job.cancellationResolutionState, 'resolved');
  assert.ok(job.cancellationResolvedAt);
  assert.ok(job.cancelledAt);
  assert.ok(timestampsEqual(job.cancellationResolvedAt, job.cancelledAt, FakeTimestamp));
  assert.equal(job.stateVersion, 2);

  // Assert Driver - activeJobId released, wallet credited 100%
  const driverDoc = seed.db.data.drivers[seed.driverId];
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.activeOfferId, null);
  assert.equal(driverDoc.walletBalance, 25000); // 20000 + 5000

  // Assert Deterministic Credit Ledger
  const creditLedger = seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId];
  assert.ok(creditLedger);
  assert.equal(exactKeys(creditLedger, WALLET_EXACT_KEYS), true);
  assert.equal(creditLedger.operationId, 'customer_cancel_credit:' + seed.jobId + ':' + seed.offerId);
  assert.equal(creditLedger.driverId, seed.driverId);
  assert.equal(creditLedger.jobId, seed.jobId);
  assert.equal(creditLedger.offerId, seed.offerId);
  assert.equal(creditLedger.type, 'customer_cancel_credit');
  assert.equal(creditLedger.commissionPaise, 5000);
  assert.equal(creditLedger.forfeiturePaise, 0);
  assert.equal(creditLedger.creditPaise, 5000);
  assert.equal(creditLedger.deltaPaise, 5000);
  assert.equal(creditLedger.balanceBeforePaise, 20000);
  assert.equal(creditLedger.balanceAfterPaise, 25000);
  assert.equal(creditLedger.cancellationPolicyEvidence, null);
  assert.equal(creditLedger.sourceType, 'customer');
  assert.equal(creditLedger.actorUid, null);

  // Assert Run
  const run = seed.db.data['jobs/' + seed.jobId + '/dispatch_runs'][String(seed.generation)];
  assert.equal(run.status, 'cancelled_customer');
  assert.equal(run.currentOfferId, seed.offerId);

  // Assert Terminal Outbox
  const outbox = seed.db.data.notification_outbox['job_cancelled_customer:' + seed.jobId];
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_cancelled_customer');
  assert.equal(outbox.payload.jobStatus, 'cancelled_customer');
  assert.equal(outbox.payload.refundAmountPaise, null);
  assert.equal(outbox.state, 'pending');
});

test('resolves customer cancellation on in_progress job (assigned)', async () => {
  const nowMs = 1000000;
  const seed = setupInProgressSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const result = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(result.resolved, true);
  assert.equal(result.previousStatus, 'in_progress');
  assert.equal(result.status, 'cancelled_customer');
  assert.equal(result.refundPaise, 5000);

  const job = seed.db.data.jobs[seed.jobId];
  assert.equal(job.status, 'cancelled_customer');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.currentOfferId, seed.offerId);
  assert.equal(job.cancellationResolutionState, 'resolved');

  const run = seed.db.data['jobs/' + seed.jobId + '/dispatch_runs'][String(seed.generation)];
  assert.equal(run.status, 'cancelled_customer');
  assert.equal(run.currentOfferId, seed.offerId);

  const driverDoc = seed.db.data.drivers[seed.driverId];
  assert.equal(driverDoc.activeJobId, null);
  assert.equal(driverDoc.walletBalance, 25000);

  const creditLedger = seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId];
  assert.ok(creditLedger);
  assert.equal(exactKeys(creditLedger, WALLET_EXACT_KEYS), true);
  assert.equal(creditLedger.deltaPaise, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TERMINAL IDEMPOTENCY & REPAIR RESILIENCE
// ─────────────────────────────────────────────────────────────────────────────

test('terminal idempotency: retry on resolved customer cancellation is a no-op', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const first = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(first.resolved, true);

  const snapBefore = cloneDb(seed.db.data);
  const second = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(second.resolved, true);
  assert.equal(second.idempotent, true);
  assert.deepEqual(seed.db.data, snapBefore);
});

test('terminal idempotency survives subsequent driver activity (new job & changed wallet)', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await manager.resolveCustomerCancellation({ jobId: seed.jobId });

  // Driver subsequently accepts another job and balance changes
  seed.db.data.drivers[seed.driverId].activeJobId = 'subsequent_job_99';
  seed.db.data.drivers[seed.driverId].walletBalance = 35000;

  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
  // Ensure subsequent driver activeJobId and balance are preserved
  assert.equal(seed.db.data.drivers[seed.driverId].activeJobId, 'subsequent_job_99');
  assert.equal(seed.db.data.drivers[seed.driverId].walletBalance, 35000);
});

test('terminal idempotency fails closed if reversal credit ledger arithmetic is corrupted', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await manager.resolveCustomerCancellation({ jobId: seed.jobId });

  // Corrupt the reversal ledger creditPaise
  seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId].creditPaise = 4000;

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. FAIL-CLOSED OCCURRENCE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

test('rejects missing job document', async () => {
  const seed = setupOfferedSeed();
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: 'non_existent' }),
    err => err instanceof DispatchError && err.code === 'DOCUMENT_NOT_FOUND'
  );
});

test('rejects job without customer cancellation marker (cancelledBy not customer)', async () => {
  const seed = setupOfferedSeed({ jobPatch: { cancelledBy: 'driver' } });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );
});

test('rejects job with cancellationResolutionState !== pending', async () => {
  const seed = setupOfferedSeed({ jobPatch: { cancellationResolutionState: 'none' } });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );
});

test('rejects job in terminal completed status', async () => {
  const seed = setupAcceptedSeed({
    jobPatch: {
      status: 'completed',
      completedAt: FakeTimestamp.fromMillis(1000000),
    },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );
});

test('rejects accepted job if debit ledger entry is missing', async () => {
  const seed = setupAcceptedSeed();
  delete seed.db.data.wallet_entries['commission_debit:' + seed.jobId + ':' + seed.offerId];

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'DOCUMENT_NOT_FOUND'
  );
});

test('rejects accepted job if credit ledger already exists before resolution', async () => {
  const seed = setupAcceptedSeed();
  seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId] = { exists: true };

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('rejects offered job if driver engagement is mismatched', async () => {
  const seed = setupOfferedSeed({ driverPatch: { activeOfferId: 'other_offer' } });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
});

test('rejects accepted job if driver activeJobId is mismatched', async () => {
  const seed = setupAcceptedSeed({ driverPatch: { activeJobId: 'other_job' } });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SCHEDULED RECONCILER SWEEP
// ─────────────────────────────────────────────────────────────────────────────

test('reconcileCustomerCancellations sweeps pending customer cancellations in order', async () => {
  const seed1 = setupOfferedSeed({ nowMs: 1000000, jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(997000) } });
  const seed2 = setupAcceptedSeed({ nowMs: 1000000, jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(998000) } });
  seed2.jobId = 'job_test_2';
  seed2.offerId = 'offer_test_2';
  seed2.driverId = 'driver_test_2';

  // Merge seed2 into seed1 db
  const db = seed1.db;
  db.data.jobs[seed2.jobId] = {
    ...seed2.db.data.jobs['job_test_1'],
    currentOfferId: seed2.offerId,
    assignedDriver: seed2.driverId,
    commissionDebitEntryId: 'commission_debit:' + seed2.jobId + ':' + seed2.offerId,
    cancellationRequestedAt: FakeTimestamp.fromMillis(998000),
  };
  db.data.drivers[seed2.driverId] = {
    ...seed2.db.data.drivers['driver_test_1'],
    activeJobId: seed2.jobId,
  };
  db.data.job_offers[seed2.offerId] = {
    ...seed2.db.data.job_offers['offer_test_1'],
    jobId: seed2.jobId,
    driverId: seed2.driverId,
  };
  db.data['jobs/' + seed2.jobId + '/dispatch_runs'] = {
    '1': {
      ...seed2.db.data['jobs/job_test_1/dispatch_runs']['1'],
      jobId: seed2.jobId,
      currentOfferId: seed2.offerId,
      candidates: [{
        ...seed2.db.data['jobs/job_test_1/dispatch_runs']['1'].candidates[0],
        driverId: seed2.driverId,
      }],
      attemptedDriverIds: [seed2.driverId],
    },
  };
  db.data.wallet_entries['commission_debit:' + seed2.jobId + ':' + seed2.offerId] = {
    ...seed2.db.data.wallet_entries['commission_debit:job_test_1:offer_test_1'],
    jobId: seed2.jobId,
    offerId: seed2.offerId,
    driverId: seed2.driverId,
    actorUid: seed2.driverId,
    operationId: 'commission_debit:' + seed2.jobId + ':' + seed2.offerId,
  };
  db.data.notification_outbox['job_accepted:' + seed2.jobId + ':' + seed2.offerId] = {
    ...seed2.db.data.notification_outbox['job_accepted:job_test_1:offer_test_1'],
    eventId: 'job_accepted:' + seed2.jobId + ':' + seed2.offerId,
    resourceId: seed2.jobId,
    recipientKey: 'customer:' + seed2.jobId,
    payload: {
      jobId: seed2.jobId,
      jobStatus: 'accepted',
      refundAmountPaise: null,
    },
  };

  const manager = createCustomerCancellationManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => 1000000,
  });

  const sweep = await manager.reconcileCustomerCancellations({ batchSize: 10 });
  assert.equal(sweep.discovered, 2);
  assert.equal(sweep.resolved, 2);
  assert.equal(sweep.failed, 0);

  assert.equal(db.data.jobs['job_test_1'].status, 'cancelled_customer');
  assert.equal(db.data.jobs['job_test_2'].status, 'cancelled_customer');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. TRIGGER PREDICATE TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('shouldProcessCustomerCancellation evaluates reactive events correctly', () => {
  const validRequestedAt = FakeTimestamp.fromMillis(1000000);

  // Pending customer cancellation on accepted job -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), true);

  // Pending customer cancellation on offered job -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'offered',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), true);

  // Pending customer cancellation on in_progress job -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'in_progress',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), true);

  // Missing or invalid cancellationReason -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), false);

  // Missing or invalid cancellationRequestedAt -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: null,
        }),
      },
    },
  }), false);

  // Non-pending resolution state -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'cancelled_customer',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'resolved',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), false);

  // Cancelled by driver -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'driver',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), false);

  // Status outside offered/accepted/in_progress -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: true,
        data: () => ({
          status: 'completed',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), false);

  // Document deleted -> false
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      after: {
        exists: false,
      },
    },
  }), false);

  // Transition: before was not pending -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      before: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'none',
          cancellationResolutionState: 'none',
        }),
      },
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), true);

  // Transition: before was already pending with same status & timestamp -> false (suppress duplicate)
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      before: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
          updatedAt: FakeTimestamp.fromMillis(999000),
        }),
      },
      after: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
          updatedAt: FakeTimestamp.fromMillis(1000000),
        }),
      },
    },
  }), false);

  // Blocker 4: BEFORE invalid marker (cancelledBy/cancellationReason null) -> AFTER valid marker -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      before: {
        exists: true,
        data: () => ({
          status: 'offered',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
          cancelledBy: null,
          cancellationReason: null,
        }),
      },
      after: {
        exists: true,
        data: () => ({
          status: 'offered',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
        }),
      },
    },
  }), true);

  // Transition: status changed from accepted to in_progress while pending -> true
  assert.equal(shouldProcessCustomerCancellation({
    data: {
      before: {
        exists: true,
        data: () => ({
          status: 'accepted',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
      after: {
        exists: true,
        data: () => ({
          status: 'in_progress',
          cancelledBy: 'customer',
          cancellationReason: 'customer_requested',
          cancellationResolutionState: 'pending',
          cancellationRequestedAt: validRequestedAt,
        }),
      },
    },
  }), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. HISTORICAL OFFER PROVENANCE (BLOCKER 3)
// ─────────────────────────────────────────────────────────────────────────────

test('historical offer provenance: validates correct offer when earlier offers exist in job_offers', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });

  // Add historical Offer A that was previously declined
  const offerA = {
    ...seed.db.data.job_offers[seed.offerId],
    jobId: seed.jobId,
    driverId: 'driver_declined_earlier',
    candidateIndex: 0,
    status: 'declined',
    resolvedAt: FakeTimestamp.fromMillis(nowMs - 20000),
    resolutionReason: 'driver_declined',
  };
  seed.db.data.job_offers['offer_historical_a'] = offerA;

  // The active offer is Offer B (seed.offerId = 'offer_test_1')
  seed.db.data.jobs[seed.jobId].currentOfferId = seed.offerId;

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  // Ensure Offer B was resolved, not historical Offer A
  assert.equal(seed.db.data.job_offers[seed.offerId].status, 'cancelled_customer');
  assert.equal(seed.db.data.job_offers['offer_historical_a'].status, 'declined');

  // Terminal retry must directly load Offer B from job.currentOfferId and succeed idempotently
  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. POSITIVE MONEY & ARITHMETIC REJECTIONS (BLOCKER 4)
// ─────────────────────────────────────────────────────────────────────────────

test('fails closed if driverCommissionPaise is zero or negative', async () => {
  const nowMs = 1000000;

  // Zero commission
  const seedZero = setupAcceptedSeed({
    nowMs,
    jobPatch: { driverCommissionPaise: 0 },
    offerPatch: { driverCommissionPaise: 0 },
    ledgerPatch: { commissionPaise: 0, deltaPaise: 0 },
  });
  const managerZero = createCustomerCancellationManager({
    db: seedZero.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => managerZero.resolveCustomerCancellation({ jobId: seedZero.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Negative commission
  const seedNeg = setupAcceptedSeed({
    nowMs,
    jobPatch: { driverCommissionPaise: -5000 },
    offerPatch: { driverCommissionPaise: -5000 },
    ledgerPatch: { commissionPaise: -5000, deltaPaise: 5000 },
  });
  const managerNeg = createCustomerCancellationManager({
    db: seedNeg.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => managerNeg.resolveCustomerCancellation({ jobId: seedNeg.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Fractional commission
  const seedFrac = setupAcceptedSeed({
    nowMs,
    jobPatch: { driverCommissionPaise: 5000.5 },
    offerPatch: { driverCommissionPaise: 5000.5 },
  });
  const managerFrac = createCustomerCancellationManager({
    db: seedFrac.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => managerFrac.resolveCustomerCancellation({ jobId: seedFrac.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('fails closed if job commission does not match offer commission', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    jobPatch: { driverCommissionPaise: 5000 },
    offerPatch: { driverCommissionPaise: 6000 },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('fails closed if debit ledger commission does not match job commission', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    ledgerPatch: { commissionPaise: 4000, deltaPaise: -4000 },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. EXACT KEYS, TIMESTAMP BINDING & PROOF EQUALITY (BLOCKERS 5A, 5B, 5C)
// ─────────────────────────────────────────────────────────────────────────────

test('fails closed if debit ledger contains extra unknown keys', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    ledgerPatch: { unknownExtraKey: 'disallowed' },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('fails closed if debit ledger createdAt does not match job acceptedAt', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    ledgerPatch: { createdAt: FakeTimestamp.fromMillis(nowMs - 99999) },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('offered cancellation rejects if debit ledger or credit ledger exists (Blocker 5C)', async () => {
  const nowMs = 1000000;

  // Pre-existing debit on offered job
  const seedWithDebit = setupOfferedSeed({ nowMs });
  seedWithDebit.db.data.wallet_entries['commission_debit:' + seedWithDebit.jobId + ':' + seedWithDebit.offerId] = {
    exists: true,
  };
  const managerDebit = createCustomerCancellationManager({
    db: seedWithDebit.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => managerDebit.resolveCustomerCancellation({ jobId: seedWithDebit.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Pre-existing credit on offered job
  const seedWithCredit = setupOfferedSeed({ nowMs });
  seedWithCredit.db.data.wallet_entries['customer_cancel_credit:' + seedWithCredit.jobId + ':' + seedWithCredit.offerId] = {
    exists: true,
  };
  const managerCredit = createCustomerCancellationManager({
    db: seedWithCredit.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });
  await assert.rejects(
    () => managerCredit.resolveCustomerCancellation({ jobId: seedWithCredit.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

test('credit entry contains exact 16 schema keys without entryId or updatedAt (Blocker 7)', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  const credit = seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId];
  assert.ok(credit);
  assert.equal(exactKeys(credit, WALLET_EXACT_KEYS), true);
  assert.equal('entryId' in credit, false);
  assert.equal('updatedAt' in credit, false);
  assert.equal(Object.keys(credit).length, 16);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. FUTURE TIMESTAMPS & SAFE INTEGER STATE VERSION (BLOCKER 6)
// ─────────────────────────────────────────────────────────────────────────────

test('fails closed with zero writes if cancellationRequestedAt is in the future (> 60s skew)', async () => {
  const nowMs = 1000000;
  const futureMs = nowMs + 120000; // 2 minutes in the future
  const seed = setupAcceptedSeed({
    nowMs,
    jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(futureMs) },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  // Zero writes assertion
  assert.deepEqual(seed.db.data, snapBefore);
});

test('pre-resolution stateVersion validation: rejects MAX_SAFE_INTEGER with zero writes', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'JOB_STATE_VERSION_INVALID'
  );
  // Zero writes assertion
  assert.deepEqual(seed.db.data, snapBefore);
});

test('pre-resolution stateVersion validation: MAX_SAFE_INTEGER - 1 increments safely to MAX_SAFE_INTEGER and terminal retry succeeds', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    jobPatch: { stateVersion: Number.MAX_SAFE_INTEGER - 1 },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  const job = seed.db.data.jobs[seed.jobId];
  assert.equal(job.stateVersion, Number.MAX_SAFE_INTEGER);

  // Terminal retry validates MAX_SAFE_INTEGER safely
  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. BLOCKER 1 — PRE-RESOLUTION REQUIRED NULL FIELD TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Blocker 1: rejects pre-resolution customer cancellation if job.completedAt is missing (offered)', async () => {
  const nowMs = 1000000;
  const seed = setupOfferedSeed({ nowMs });
  delete seed.db.data.jobs[seed.jobId].completedAt;
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'CANCELLATION_CONFLICT'
  );
  assert.deepEqual(seed.db.data, snapBefore);
});

test('Blocker 1: rejects pre-resolution customer cancellation if job.completedAt is missing (accepted)', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  delete seed.db.data.jobs[seed.jobId].completedAt;
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'ACCEPTANCE_CONFLICT'
  );
  // Zero writes: no credit ledger and driver wallet unchanged
  assert.deepEqual(seed.db.data, snapBefore);
  assert.equal(seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId], undefined);
  assert.equal(seed.db.data.drivers[seed.driverId].walletBalance, 20000);
});

test('Blocker 1: rejects pre-resolution customer cancellation if job.completedAt is missing (in_progress)', async () => {
  const nowMs = 1000000;
  const seed = setupInProgressSeed({ nowMs });
  delete seed.db.data.jobs[seed.jobId].completedAt;
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'IN_PROGRESS_CONFLICT'
  );
  assert.deepEqual(seed.db.data, snapBefore);
  assert.equal(seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId], undefined);
  assert.equal(seed.db.data.drivers[seed.driverId].walletBalance, 20000);
});

test('Blocker 1: rejects pre-resolution customer cancellation if job.completedAt is a timestamp or wrong type', async () => {
  const nowMs = 1000000;
  for (const status of ['offered', 'accepted', 'in_progress']) {
    for (const badVal of [FakeTimestamp.fromMillis(999000), '2026-09-01T10:00:00Z', 12345, true]) {
      const seed = status === 'offered' ? setupOfferedSeed({ nowMs, jobPatch: { completedAt: badVal } })
        : status === 'accepted' ? setupAcceptedSeed({ nowMs, jobPatch: { completedAt: badVal } })
        : setupInProgressSeed({ nowMs, jobPatch: { completedAt: badVal } });
      const snapBefore = cloneDb(seed.db.data);
      const manager = createCustomerCancellationManager({
        db: seed.db,
        TimestampClass: FakeTimestamp,
        now: () => nowMs,
      });

      const expectedCode = status === 'offered' ? 'CANCELLATION_CONFLICT'
        : status === 'accepted' ? 'ACCEPTANCE_CONFLICT' : 'IN_PROGRESS_CONFLICT';
      await assert.rejects(
        () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
        err => err instanceof DispatchError && err.code === expectedCode
      );
      assert.deepEqual(seed.db.data, snapBefore);
    }
  }
});

test('Blocker 1: rejects if offer.completedAt is missing or non-null', async () => {
  const nowMs = 1000000;
  for (const status of ['offered', 'accepted', 'in_progress']) {
    const seed = status === 'offered' ? setupOfferedSeed({ nowMs })
      : status === 'accepted' ? setupAcceptedSeed({ nowMs })
      : setupInProgressSeed({ nowMs });
    delete seed.db.data.job_offers[seed.offerId].completedAt;
    const snapBefore = cloneDb(seed.db.data);
    const manager = createCustomerCancellationManager({
      db: seed.db,
      TimestampClass: FakeTimestamp,
      now: () => nowMs,
    });

    const expectedCode = status === 'offered' ? 'OFFER_INVALID'
      : status === 'accepted' ? 'OFFER_INVALID' : 'OFFER_INVALID';
    await assert.rejects(
      () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
      err => err instanceof DispatchError && err.code === expectedCode
    );
    assert.deepEqual(seed.db.data, snapBefore);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. BLOCKER 2 — OFFER / LIFECYCLE CHRONOLOGY TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Blocker 2A: rejects if offer.expiresAt is before offeredAt', async () => {
  const nowMs = 1000000;
  const seed = setupOfferedSeed({
    nowMs,
    offerPatch: { expiresAt: FakeTimestamp.fromMillis(nowMs - 6000) },
    jobPatch: { offerExpiresAt: FakeTimestamp.fromMillis(nowMs - 6000) },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(seed.db.data, snapBefore);
});

test('Blocker 2B: rejects if offeredAt is after cancellationRequestedAt', async () => {
  const nowMs = 1000000;
  // offeredAt = nowMs - 500, cancellationRequestedAt = nowMs - 1000 (contradictory)
  const seed = setupOfferedSeed({
    nowMs,
    offerPatch: { offeredAt: FakeTimestamp.fromMillis(nowMs - 500) },
    jobPatch: {
      offeredAt: FakeTimestamp.fromMillis(nowMs - 500),
      cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs - 1000),
    },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(seed.db.data, snapBefore);
});

test('Blocker 2B: legitimate customer cancellation AFTER offer expiresAt still succeeds on OFFERED job', async () => {
  const nowMs = 1000000;
  // Offer created 60s ago, expired 15s ago (45s offer window). Customer cancels 5s ago.
  const offeredAt = FakeTimestamp.fromMillis(nowMs - 60000);
  const expiresAt = FakeTimestamp.fromMillis(nowMs - 15000);
  const requestedAt = FakeTimestamp.fromMillis(nowMs - 5000);

  const seed = setupOfferedSeed({
    nowMs,
    offerPatch: { offeredAt, expiresAt },
    jobPatch: { offeredAt, offerExpiresAt: expiresAt, cancellationRequestedAt: requestedAt },
  });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);
  assert.equal(res.status, 'cancelled_customer');

  // Terminal retry also succeeds
  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

test('Blocker 2C (Case A): rejects accepted cancellation if acceptedAt >= expiresAt (impossible accepted expiry)', async () => {
  const nowMs = 1000000;
  // offer expired at nowMs - 6000, but acceptedAt is nowMs - 5000 (impossible)
  const seed = setupAcceptedSeed({
    nowMs,
    offerPatch: { expiresAt: FakeTimestamp.fromMillis(nowMs - 6000) },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(seed.db.data, snapBefore);
  assert.equal(seed.db.data.wallet_entries['customer_cancel_credit:' + seed.jobId + ':' + seed.offerId], undefined);
  assert.equal(seed.db.data.drivers[seed.driverId].walletBalance, 20000);
});

test('Blocker 2C: rejects accepted cancellation if acceptedAt > cancellationRequestedAt', async () => {
  const nowMs = 1000000;
  // acceptedAt = nowMs - 5000, cancellationRequestedAt = nowMs - 6000 (impossible)
  const seed = setupAcceptedSeed({
    nowMs,
    jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs - 6000) },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(seed.db.data, snapBefore);
});

test('Blocker 2D: rejects in_progress cancellation if inProgressAt > cancellationRequestedAt', async () => {
  const nowMs = 1000000;
  // inProgressAt = nowMs - 3000, cancellationRequestedAt = nowMs - 4000 (impossible)
  const seed = setupInProgressSeed({
    nowMs,
    jobPatch: { cancellationRequestedAt: FakeTimestamp.fromMillis(nowMs - 4000) },
  });
  const snapBefore = cloneDb(seed.db.data);
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
  assert.deepEqual(seed.db.data, snapBefore);
});

test('Blocker 2E (Case B): terminal retry fails closed if offer.offeredAt > cancellationResolvedAt', async () => {
  const nowMs = 1000000;
  const seed = setupOfferedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  // Corrupt terminal evidence: offeredAt is in future relative to cancellationResolvedAt
  seed.db.data.job_offers[seed.offerId].offeredAt = FakeTimestamp.fromMillis(nowMs + 10000);

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
});

test('Blocker 2E: terminal retry fails closed if offer.acceptedAt >= offer.expiresAt', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({ nowMs });
  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  // Corrupt terminal evidence: expiresAt is before acceptedAt
  seed.db.data.job_offers[seed.offerId].expiresAt = FakeTimestamp.fromMillis(nowMs - 8000);

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LIFECYCLE_TIMESTAMP_INVALID'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. BLOCKER 3 — ORIGINAL DEBIT REQUEST ATTRIBUTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('Blocker 3: acceptance WITH valid requestId succeeds pre-resolution and terminal retry succeeds', async () => {
  const nowMs = 1000000;
  const reqId = 'req_stage4_accept_123';
  const seed = setupAcceptedSeed({
    nowMs,
    offerPatch: { acceptRequestId: reqId },
    ledgerPatch: { sourceRequestId: reqId },
  });

  // Also seed the processed request receipt for the acceptRequestId
  const payloadHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ jobId: seed.jobId, offerId: seed.offerId }), 'utf8').digest('hex');
  seed.db.data.processed_requests = {
    [reqId]: {
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
      processedAt: FakeTimestamp.fromMillis(nowMs - 5000),
      claimedAt: FakeTimestamp.fromMillis(nowMs - 5000),
      leaseUntil: null,
      ownerToken: null,
    },
  };

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

test('Blocker 3: acceptance WITHOUT requestId (both null) succeeds pre-resolution and terminal retry succeeds', async () => {
  const nowMs = 1000000;
  const seed = setupAcceptedSeed({
    nowMs,
    offerPatch: { acceptRequestId: null },
    ledgerPatch: { sourceRequestId: null },
  });

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  const retry = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(retry.resolved, true);
  assert.equal(retry.idempotent, true);
});

test('Blocker 3: pre-resolution rejects if debit.sourceRequestId does not match offer.acceptRequestId', async () => {
  const nowMs = 1000000;
  const probes = [
    { offerReq: 'req_1', debitReq: 'wrong_req' },
    { offerReq: 'req_1', debitReq: 123 },
    { offerReq: 'req_1', debitReq: null },
    { offerReq: null, debitReq: 'req_1' },
    { offerReq: 123, debitReq: 123 },
    { offerReq: '', debitReq: '' },
    { offerReq: 'req/with/slash', debitReq: 'req/with/slash' },
  ];

  for (const probe of probes) {
    const seed = setupAcceptedSeed({
      nowMs,
      offerPatch: { acceptRequestId: probe.offerReq },
      ledgerPatch: { sourceRequestId: probe.debitReq },
    });
    const snapBefore = cloneDb(seed.db.data);
    const manager = createCustomerCancellationManager({
      db: seed.db,
      TimestampClass: FakeTimestamp,
      now: () => nowMs,
    });

    await assert.rejects(
      () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
      err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
    );
    assert.deepEqual(seed.db.data, snapBefore);
  }
});

test('Blocker 3: terminal retry rejects if debit.sourceRequestId or offer.acceptRequestId is corrupted', async () => {
  const nowMs = 1000000;
  const reqId = 'req_stage4_accept_abc';
  const seed = setupAcceptedSeed({
    nowMs,
    offerPatch: { acceptRequestId: reqId },
    ledgerPatch: { sourceRequestId: reqId },
  });
  const payloadHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ jobId: seed.jobId, offerId: seed.offerId }), 'utf8').digest('hex');
  seed.db.data.processed_requests = {
    [reqId]: {
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
      processedAt: FakeTimestamp.fromMillis(nowMs - 5000),
      claimedAt: FakeTimestamp.fromMillis(nowMs - 5000),
      leaseUntil: null,
      ownerToken: null,
    },
  };

  const manager = createCustomerCancellationManager({
    db: seed.db,
    TimestampClass: FakeTimestamp,
    now: () => nowMs,
  });

  const res = await manager.resolveCustomerCancellation({ jobId: seed.jobId });
  assert.equal(res.resolved, true);

  // Corrupt debit sourceRequestId in terminal state
  const debitKey = 'commission_debit:' + seed.jobId + ':' + seed.offerId;
  seed.db.data.wallet_entries[debitKey].sourceRequestId = 'wrong-request';

  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Corrupt to number
  seed.db.data.wallet_entries[debitKey].sourceRequestId = 123;
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );

  // Corrupt to null while offer has string
  seed.db.data.wallet_entries[debitKey].sourceRequestId = null;
  await assert.rejects(
    () => manager.resolveCustomerCancellation({ jobId: seed.jobId }),
    err => err instanceof DispatchError && err.code === 'LEDGER_INVALID'
  );
});

