'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint } = require('firebase-admin/firestore');
const { createDeclineJobManager } = require('../../../firebase/functions/src/dispatch/declineJob');
const { createAcceptJobManager } = require('../../../firebase/functions/src/dispatch/acceptJob');
const { createOfferTimeoutManager } = require('../../../firebase/functions/src/dispatch/offerTimeout');
const { createDispatchService } = require('../../../firebase/functions/src/dispatch/dispatchService');
const { createDispatchRecovery } = require('../../../firebase/functions/src/dispatch/dispatchRecovery');
const { createTaskQueueService } = require('../../../firebase/functions/src/services/taskQueueService');
const { FakeTaskQueue } = require('../fakeDeps');
const { paidJob, config, driver } = require('../fixtures');
const { POLICY_KEYS } = require('../../../firebase/functions/src/dispatch/dispatchValidation');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage5-decline-test';
const app = initializeApp({ projectId: project }, 'stage5-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = (jobId, gen = 1) => db.doc('jobs/' + jobId + '/dispatch_runs/' + gen);
const driverRef = id => db.doc('drivers/' + id);
const receiptRef = id => db.doc('processed_requests/' + id);
const ledgerRef = (jobId, offerId) => db.doc('wallet_entries/commission_debit:' + jobId + ':' + offerId);
const outboxRef = (jobId, offerId) => db.doc('notification_outbox/job_accepted:' + jobId + ':' + offerId);
const refundRef = jobId => db.doc('refund_requests/' + jobId);

const read = async ref => (await ref.get()).data();

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

async function seedOfferedJobAndRun({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  generation = 1,
  commissionPaise = 5000,
  lifetimeMs = 45000,
  offerPatch = {},
  jobPatch = {},
  runPatch = {},
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
    ...jobPatch,
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
    estimatedFarePaise: 250000,
    driverCommissionPaise: commissionPaise,
    createdAt: offeredAt,
    updatedAt: offeredAt,
    ...offerPatch,
  };
  await offerRef(offerId).set(o);

  const fullConfig = config(T, clock);
  const policySnapshot = Object.fromEntries(POLICY_KEYS.map(key => [key, fullConfig[key]]));

  const candidates = [{
    driverId,
    roundIndex: 0,
    haversineDistanceKm: 3.5,
    matrixEtaSeconds: 600,
    matrixDistanceMeters: 5000,
    rankingMode: 'ola',
    outcome: 'offered',
    reasonCode: null,
  }, ...extraCandidates];

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
    ...runPatch,
  };
  await runRef(jobId, generation).set(r);

  await driverRef(driverId).update({ activeOfferId: offerId });
}

// =========================================================================
// A. DECLINE VS TIMEOUT RACE
// =========================================================================
test('A. decline vs timeout race: many interleavings, exactly one winner, zero double transitions', async () => {
  let declineWins = 0;
  let timeoutWins = 0;

  for (let i = 0; i < 6; i++) {
    const baseClock = Date.parse('2026-09-02T10:00:00Z') + (i * 100000);
    clock = baseClock;

    const jobId = 'job_dec_to_race_' + i;
    const driverId = 'driver_dec_to_race_' + i;
    const offerId = 'offer_dec_to_race_' + i;
    const reqId = 'req_dec_to_' + i;

    await seedDriver(driverId, { walletBalance: 20000 });
    await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

    const declineManager = createDeclineJobManager({ db, TimestampClass: T, now });
    const timeoutManager = createOfferTimeoutManager({ db, TimestampClass: T, now });

    // Race decline and timeout at expiry boundary:
    // Even iterations: clock is just before expiry (baseClock + 44,999ms) -> decline valid
    // Odd iterations: clock is at expiry (baseClock + 45,000ms) -> timeout valid
    clock = baseClock + (i % 2 === 0 ? 44999 : 45000);

    const results = await Promise.allSettled([
      declineManager.declineJob({ jobId, offerId, driverUid: driverId, requestId: reqId, triggerCascade: false }),
      timeoutManager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: 1, triggerCascade: false }),
    ]);

    const declineSucceeded = results[0].status === 'fulfilled';
    const timeoutSucceeded = results[1].status === 'fulfilled' && results[1].value?.expired === true;

    // Exactly one winner
    assert.notEqual(declineSucceeded, timeoutSucceeded, 'Iteration ' + i + ': exactly one must succeed');

    const job = await read(jobRef(jobId));
    const offer = await read(offerRef(offerId));
    const run = await read(runRef(jobId));
    const drv = await read(driverRef(driverId));
    const receipt = await read(receiptRef(reqId));

    assert.equal(job.status, 'pending_offer');
    assert.equal(job.dispatchState, 'ready');
    assert.equal(job.offeredTo, null);
    assert.equal(job.currentOfferId, null);
    assert.equal(job.stateVersion, 2);
    assert.equal(drv.activeOfferId, null);
    assert.equal(drv.activeJobId, null);
    assert.equal(drv.walletBalance, 20000, 'Wallet balance never altered in decline or timeout');

    if (declineSucceeded) {
      declineWins++;
      assert.equal(offer.status, 'declined');
      assert.equal(offer.resolutionReason, 'declined_by_driver');
      assert.equal(run.candidates[0].outcome, 'declined');
      assert.ok(receipt, 'Receipt must exist when decline won');
      assert.equal(receipt.status, 'completed');
    } else {
      timeoutWins++;
      assert.equal(offer.status, 'expired');
      assert.equal(offer.resolutionReason, 'offer_expired');
      assert.equal(run.candidates[0].outcome, 'expired');
      assert.equal(receipt, undefined, 'Receipt must not exist when timeout won');
    }
  }

  assert.ok(declineWins > 0, 'Must have at least one decline win');
  assert.ok(timeoutWins > 0, 'Must have at least one timeout win');
});

// =========================================================================
// B. DECLINE VS ACCEPT RACE
// =========================================================================
test('B. decline vs accept race: concurrent real managers, exactly one wins, zero debit if decline wins', async () => {
  let acceptWins = 0;
  let declineWins = 0;

  for (let i = 0; i < 4; i++) {
    const baseClock = Date.parse('2026-09-02T10:00:00Z') + (i * 100000);
    clock = baseClock;

    const jobId = 'job_dec_acc_race_' + i;
    const driverId = 'driver_dec_acc_race_' + i;
    const offerId = 'offer_dec_acc_race_' + i;
    const acceptReqId = 'req_acc_' + i;
    const declineReqId = 'req_dec_' + i;

    await seedDriver(driverId, { walletBalance: 25000 });
    await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

    const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });
    const declineManager = createDeclineJobManager({ db, TimestampClass: T, now });

    // Race accept and decline concurrently well before expiry
    clock = baseClock + 10000;

    const results = await Promise.allSettled([
      acceptManager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: acceptReqId }),
      declineManager.declineJob({ jobId, offerId, driverUid: driverId, requestId: declineReqId, triggerCascade: false }),
    ]);

    const acceptSucceeded = results[0].status === 'fulfilled';
    const declineSucceeded = results[1].status === 'fulfilled';

    // Exactly one winner
    assert.notEqual(acceptSucceeded, declineSucceeded, 'Iteration ' + i + ': exactly one of accept or decline must win');

    const job = await read(jobRef(jobId));
    const offer = await read(offerRef(offerId));
    const run = await read(runRef(jobId));
    const drv = await read(driverRef(driverId));
    const ledger = await read(ledgerRef(jobId, offerId));
    const outbox = await read(outboxRef(jobId, offerId));

    if (acceptSucceeded) {
      acceptWins++;
      assert.equal(job.status, 'accepted');
      assert.equal(job.dispatchState, 'assigned');
      assert.equal(job.assignedDriver, driverId);
      assert.equal(offer.status, 'accepted');
      assert.equal(run.status, 'assigned');
      assert.equal(run.candidates[0].outcome, 'accepted');
      assert.equal(drv.activeJobId, jobId);
      assert.equal(drv.walletBalance, 20000); // Debited!
      assert.ok(ledger);
      assert.ok(outbox);
    } else {
      declineWins++;
      assert.equal(job.status, 'pending_offer');
      assert.equal(job.dispatchState, 'ready');
      assert.equal(job.assignedDriver, null);
      assert.equal(offer.status, 'declined');
      assert.equal(run.candidates[0].outcome, 'declined');
      assert.equal(drv.activeJobId, null);
      assert.equal(drv.walletBalance, 25000, 'ZERO wallet debit when decline wins');
      assert.equal(ledger, undefined, 'ZERO ledger created when decline wins');
      assert.equal(outbox, undefined, 'ZERO outbox created when decline wins');
    }
  }
});

// =========================================================================
// C. DUPLICATE DECLINE RACE
// =========================================================================
test('C. duplicate decline race: same requestId concurrently results in single transition + single receipt', async () => {
  const jobId = 'job_dup_decline';
  const driverId = 'driver_dup_decline';
  const offerId = 'offer_dup_decline';
  const reqId = 'req_dup_decline_1';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const declineManager = createDeclineJobManager({ db, TimestampClass: T, now });

  const results = await Promise.allSettled([
    declineManager.declineJob({ jobId, offerId, driverUid: driverId, requestId: reqId, triggerCascade: false }),
    declineManager.declineJob({ jobId, offerId, driverUid: driverId, requestId: reqId, triggerCascade: false }),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[0].value.declined, true);
  assert.equal(results[1].value.declined, true);

  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');
  assert.equal(job.stateVersion, 2); // Exactly ONE increment

  const offer = await read(offerRef(offerId));
  assert.equal(offer.status, 'declined');

  const receipt = await read(receiptRef(reqId));
  assert.ok(receipt);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actorUid, driverId);

  // Assert no financial artifacts
  assert.equal(await read(ledgerRef(jobId, offerId)), undefined);
  assert.equal(await read(outboxRef(jobId, offerId)), undefined);
});

// =========================================================================
// D. DECLINE THEN STALE TIMEOUT
// =========================================================================
test('D. decline then stale timeout: timeout zero-write no-op', async () => {
  const jobId = 'job_dec_stale_to';
  const driverId = 'driver_dec_stale_to';
  const offerId = 'offer_dec_stale_to';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const declineManager = createDeclineJobManager({ db, TimestampClass: T, now });
  const timeoutManager = createOfferTimeoutManager({ db, TimestampClass: T, now });

  // 1. Driver declines before expiry
  const declineRes = await declineManager.declineJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req_stale_1',
    triggerCascade: false,
  });
  assert.equal(declineRes.declined, true);

  const snapAfterDecline = {
    job: await read(jobRef(jobId)),
    offer: await read(offerRef(offerId)),
    run: await read(runRef(jobId)),
    driver: await read(driverRef(driverId)),
  };

  // 2. Advance clock past expiry; stale timeout task arrives
  clock += 50000;
  const timeoutRes = await timeoutManager.expireOfferTimeout({
    jobId,
    offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });

  // Stale timeout must no-op
  assert.equal(timeoutRes.expired, false);
  assert.equal(timeoutRes.reason, 'OFFER_NOT_ACTIVE');

  // Assert ZERO writes by stale timeout
  const snapAfterTimeout = {
    job: await read(jobRef(jobId)),
    offer: await read(offerRef(offerId)),
    run: await read(runRef(jobId)),
    driver: await read(driverRef(driverId)),
  };

  assert.deepEqual(snapAfterTimeout.job, snapAfterDecline.job);
  assert.deepEqual(snapAfterTimeout.offer, snapAfterDecline.offer);
  assert.deepEqual(snapAfterTimeout.run, snapAfterDecline.run);
  assert.deepEqual(snapAfterTimeout.driver, snapAfterDecline.driver);
});

// =========================================================================
// E. CRASH WINDOW / DURABLE CASCADE
// =========================================================================
test('E. crash window / durable cascade: decline committed without post-commit kick, durable reconciler offers next candidate', async () => {
  const jobId = 'job_crash_reconcile';
  const driverA = 'driver_crash_A';
  const driverB = 'driver_crash_B';
  const offerA = 'offer_crash_A';

  await seedDriver(driverA, { location: new GeoPoint(18.525, 73.86) });
  await seedDriver(driverB, { location: new GeoPoint(18.526, 73.86) });

  await seedOfferedJobAndRun({
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
  const dispatchService = createDispatchService({ db, now, taskQueueService });

  const declineManager = createDeclineJobManager({
    db,
    TimestampClass: T,
    now,
    dispatchService,
  });

  // Commit decline with triggerCascade: false (simulating process crash before dispatch kick)
  const decRes = await declineManager.declineJob({
    jobId,
    offerId: offerA,
    driverUid: driverA,
    requestId: 'req_crash_1',
    triggerCascade: false, // CRASH SIMULATION
  });
  assert.equal(decRes.declined, true);

  // Job is sitting in pending_offer / ready
  const jobBeforeReconcile = await read(jobRef(jobId));
  assert.equal(jobBeforeReconcile.status, 'pending_offer');
  assert.equal(jobBeforeReconcile.dispatchState, 'ready');

  // Now run the actual Stage 2 durable reconciler
  const recovery = createDispatchRecovery({ db, service: dispatchService, batchSize: 10 });
  const reconcileCounts = await recovery.reconcilePendingJobs();

  assert.equal(reconcileCounts.offered, 1);

  // Job is now offered to driver B!
  const jobAfter = await read(jobRef(jobId));
  assert.equal(jobAfter.status, 'offered');
  assert.equal(jobAfter.dispatchState, 'offered');
  assert.equal(jobAfter.offeredTo, driverB);

  const runAfter = await read(runRef(jobId));
  assert.equal(runAfter.candidates[0].outcome, 'declined');
  assert.equal(runAfter.candidates[1].outcome, 'offered');
  assert.equal(runAfter.nextCandidateIndex, 2);
});

// =========================================================================
// F. SAME-GENERATION CASCADE (3 CANDIDATES)
// =========================================================================
test('F. same-generation cascade: 3 candidates, A declines, B is offered next, A never re-offered, nextCandidateIndex not double-incremented', async () => {
  const jobId = 'job_3_cascade';
  const driverA = 'driver_3_A';
  const driverB = 'driver_3_B';
  const driverC = 'driver_3_C';
  const offerA = 'offer_3_A';

  await seedDriver(driverA, { location: new GeoPoint(18.525, 73.86) });
  await seedDriver(driverB, { location: new GeoPoint(18.526, 73.86) });
  await seedDriver(driverC, { location: new GeoPoint(18.527, 73.86) });

  await seedOfferedJobAndRun({
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
    }, {
      driverId: driverC,
      roundIndex: 0,
      haversineDistanceKm: 5.0,
      matrixEtaSeconds: 750,
      matrixDistanceMeters: 6500,
      rankingMode: 'ola',
      outcome: 'pending',
      reasonCode: null,
    }],
  });

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const dispatchService = createDispatchService({ db, now, taskQueueService });

  const declineManager = createDeclineJobManager({
    db,
    TimestampClass: T,
    now,
    dispatchService,
  });

  // Candidate A declines (with automatic cascade enabled)
  const decRes = await declineManager.declineJob({
    jobId,
    offerId: offerA,
    driverUid: driverA,
    requestId: 'req_3_A',
    triggerCascade: true,
  });
  assert.equal(decRes.declined, true);

  // Job must now be offered to driver B
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'offered');
  assert.equal(job.dispatchState, 'offered');
  assert.equal(job.offeredTo, driverB);

  // Run checks
  const run = await read(runRef(jobId));
  assert.equal(run.candidates[0].driverId, driverA);
  assert.equal(run.candidates[0].outcome, 'declined');
  assert.equal(run.candidates[1].driverId, driverB);
  assert.equal(run.candidates[1].outcome, 'offered');
  assert.equal(run.candidates[2].driverId, driverC);
  assert.equal(run.candidates[2].outcome, 'pending');

  // nextCandidateIndex was 1 at offer A, became 2 at offer B, not double-incremented!
  assert.equal(run.nextCandidateIndex, 2);
  assert.deepEqual(run.attemptedDriverIds, [driverA, driverB]);
  assert.deepEqual(run.excludedDriverIds, []);

  // Driver A is released and not active
  const drvA = await read(driverRef(driverA));
  assert.equal(drvA.activeOfferId, null);

  // Driver B is engaged
  const drvB = await read(driverRef(driverB));
  assert.equal(drvB.activeOfferId, run.currentOfferId);
});

// =========================================================================
// G. LAST CANDIDATE DECLINES (GENUINE EXHAUSTION)
// =========================================================================
test('G. last candidate declines: finite policy genuinely exhausts, cancelled_system and refund_requests produced exactly once', async () => {
  const jobId = 'job_exhaustion';
  const driverA = 'driver_ex_A';
  const driverB = 'driver_ex_B';
  const offerB = 'offer_ex_B';

  await seedDriver(driverA, { location: new GeoPoint(18.525, 73.86) });
  await seedDriver(driverB, { location: new GeoPoint(18.526, 73.86) });

  // Run where candidate 0 (driver A) already declined, candidate 1 (driver B) is currently offered
  await seedOfferedJobAndRun({
    jobId,
    driverId: driverB,
    offerId: offerB,
    commissionPaise: 5000,
    offerPatch: { candidateIndex: 1 },
    jobPatch: { bookingFeePaise: 10000, stateVersion: 2 },
    runPatch: {
      candidates: [{
        driverId: driverA,
        roundIndex: 0,
        haversineDistanceKm: 3.5,
        matrixEtaSeconds: 600,
        matrixDistanceMeters: 5000,
        rankingMode: 'ola',
        outcome: 'declined',
        reasonCode: null,
      }, {
        driverId: driverB,
        roundIndex: 0,
        haversineDistanceKm: 4.0,
        matrixEtaSeconds: 650,
        matrixDistanceMeters: 5500,
        rankingMode: 'ola',
        outcome: 'offered',
        reasonCode: null,
      }],
      nextCandidateIndex: 2,
      attemptedDriverIds: [driverA, driverB],
    },
  });

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const dispatchService = createDispatchService({ db, now, taskQueueService });

  const declineManager = createDeclineJobManager({
    db,
    TimestampClass: T,
    now,
    dispatchService,
  });

  // Last candidate (driver B) declines
  const decRes = await declineManager.declineJob({
    jobId,
    offerId: offerB,
    driverUid: driverB,
    requestId: 'req_ex_B',
    triggerCascade: true,
  });
  assert.equal(decRes.declined, true);

  // Terminal state: job is cancelled_system / no_driver_found
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'cancelled_system');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.cancelledBy, 'system');
  assert.equal(job.cancellationReason, 'no_driver_found');
  assert.equal(job.refundState, 'pending');
  assert.equal(job.refundRequestId, jobId);

  // Run is exhausted and finalized
  const run = await read(runRef(jobId));
  assert.equal(run.status, 'exhausted');
  assert.ok(run.finalizedAt);
  assert.equal(run.candidates[1].outcome, 'declined');

  // Refund request exists exactly once
  const refund = await read(refundRef(jobId));
  assert.ok(refund);
  assert.equal(refund.jobId, jobId);
  assert.equal(refund.amountPaise, 10000);
  assert.equal(refund.reason, 'no_driver_found');
  assert.equal(refund.providerIdempotencyKey, 'refund_no_driver_found_' + jobId);
  assert.equal(refund.state, 'pending');
});

// =========================================================================
// H. CUSTOMER CANCELLATION RACE
// =========================================================================
test('H. customer cancellation race: customer marker wins first, normal decline does not overwrite it', async () => {
  const jobId = 'job_cust_cancel_race';
  const driverId = 'driver_cust_cancel_race';
  const offerId = 'offer_cust_cancel_race';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  // Customer cancellation marker commits first
  await jobRef(jobId).update({
    cancellationRequestedAt: T.fromMillis(clock + 1000),
    cancellationResolutionState: 'pending',
  });

  const declineManager = createDeclineJobManager({ db, TimestampClass: T, now });

  // Driver decline attempts to run
  await assert.rejects(
    () => declineManager.declineJob({
      jobId,
      offerId,
      driverUid: driverId,
      requestId: 'req_cancel_race',
    }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );

  // Assert customer marker is untouched and zero decline writes occurred
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'offered');
  assert.equal(job.cancellationResolutionState, 'pending');

  const offer = await read(offerRef(offerId));
  assert.equal(offer.status, 'offered'); // Not overwritten to declined!

  const receipt = await read(receiptRef('req_cancel_race'));
  assert.equal(receipt, undefined);
});
