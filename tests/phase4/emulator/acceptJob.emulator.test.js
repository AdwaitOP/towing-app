'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint } = require('firebase-admin/firestore');
const { createAcceptJobManager } = require('../../../firebase/functions/src/dispatch/acceptJob');
const { createOfferTimeoutManager } = require('../../../firebase/functions/src/dispatch/offerTimeout');
const { paidJob, config, driver } = require('../fixtures');
const { POLICY_KEYS } = require('../../../firebase/functions/src/dispatch/dispatchValidation');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage4-acceptance-test';
const app = initializeApp({ projectId: project }, 'stage4-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = (jobId, gen = 1) => db.doc('jobs/' + jobId + '/dispatch_runs/' + gen);
const driverRef = id => db.doc('drivers/' + id);
const ledgerRef = (jobId, offerId) => db.doc('wallet_entries/commission_debit:' + jobId + ':' + offerId);
const outboxRef = (jobId, offerId) => db.doc('notification_outbox/job_accepted:' + jobId + ':' + offerId);

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

  const r = {
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
  await runRef(jobId, generation).set(r);

  await driverRef(driverId).update({ activeOfferId: offerId });
}

// =========================================================================
// A. Accept vs Timeout Race
// =========================================================================
test('A. accept vs timeout race: exactly one winner, zero double transitions, zero commission debit on timeout', async () => {
  let acceptWins = 0;
  let timeoutWins = 0;
  for (let i = 0; i < 6; i++) {
    const baseClock = Date.parse('2026-09-02T10:00:00Z') + (i * 100000);
    clock = baseClock;

    const jobId = 'job_race_' + i;
    const driverId = 'driver_race_' + i;
    const offerId = 'offer_race_' + i;

    await seedDriver(driverId, { walletBalance: 20000 });
    await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

    const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });
    const timeoutManager = createOfferTimeoutManager({ db, TimestampClass: T, now });

    // Race accept and timeout at expiry boundary:
    // Even iterations: clock is just before expiry (baseClock + 44,999ms) -> accept is valid
    // Odd iterations: clock is at expiry (baseClock + 45,000ms) -> timeout is valid / offer expired
    clock = baseClock + (i % 2 === 0 ? 44999 : 45000);

    const results = await Promise.allSettled([
      acceptManager.acceptJob({ jobId, offerId, driverUid: driverId }),
      timeoutManager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: 1, triggerCascade: false }),
    ]);

    const acceptSucceeded = results[0].status === 'fulfilled';
    const timeoutSucceeded = results[1].status === 'fulfilled' && results[1].value?.expired === true;

    // Exactly one winner
    assert.notEqual(acceptSucceeded, timeoutSucceeded, 'Iteration ' + i + ': exactly one of accept or timeout must succeed');

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
      assert.equal(drv.walletBalance, 15000); // 20000 - 5000
      assert.ok(ledger);
      assert.equal(ledger.deltaPaise, -5000);
      assert.ok(outbox);
      assert.equal(outbox.eventType, 'job_accepted');
    } else {
      timeoutWins++;
      // Timeout won
      assert.equal(offer.status, 'expired');
      assert.equal(drv.walletBalance, 20000, 'Driver wallet must not be debited when timeout won');
      assert.equal(drv.activeJobId, null);
      assert.equal(ledger, undefined, 'Commission ledger must not exist when timeout won');
      assert.equal(outbox, undefined, 'Outbox record must not exist when timeout won');
    }
  }
  assert.ok(acceptWins > 0, 'Must have at least one accept win across race iterations');
  assert.ok(timeoutWins > 0, 'Must have at least one timeout win across race iterations');
});

// =========================================================================
// B. Duplicate Accept Race
// =========================================================================
test('B. duplicate accept race: concurrent calls by same driver result in single debit and single ledger', async () => {
  const jobId = 'job_dup';
  const driverId = 'driver_dup';
  const offerId = 'offer_dup';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const manager = createAcceptJobManager({ db, TimestampClass: T, now });

  // Two simultaneous calls
  const [res1, res2] = await Promise.all([
    manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
    manager.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req_1' }),
  ]);

  assert.equal(res1.accepted, true);
  assert.equal(res2.accepted, true);
  // One of them was the initial win, the other was idempotent
  const hasIdempotent = res1.idempotent === true || res2.idempotent === true;
  assert.equal(hasIdempotent, true);

  const job = await read(jobRef(jobId));
  const drv = await read(driverRef(driverId));
  const ledger = await read(ledgerRef(jobId, offerId));
  const outbox = await read(outboxRef(jobId, offerId));

  // Exactly single debit
  assert.equal(drv.walletBalance, 15000); // 20000 - 5000 (NOT 10000!)
  assert.equal(job.status, 'accepted');
  assert.equal(job.assignedDriver, driverId);

  // Exactly one ledger document
  assert.ok(ledger);
  assert.equal(ledger.deltaPaise, -5000);
  assert.equal(ledger.balanceAfterPaise, 15000);

  // Exactly one outbox document
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_accepted');
});

// =========================================================================
// C. Stale Driver / Stale Offer Race
// =========================================================================
test('C. stale driver / stale offer race: stale prior offer fails closed with zero writes', async () => {
  const jobId = 'job_stale';
  const driverId = 'driver_stale_1';
  const staleDriverId = 'driver_stale_2';
  const offerId = 'offer_stale_1';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedDriver(staleDriverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const manager = createAcceptJobManager({ db, TimestampClass: T, now });

  // Stale driver tries to accept
  await assert.rejects(
    () => manager.acceptJob({ jobId, offerId, driverUid: staleDriverId }),
    err => err.code === 'WRONG_DRIVER' || err.code === 'OFFER_DRIVER_MISMATCH' || err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );

  const staleDrv = await read(driverRef(staleDriverId));
  assert.equal(staleDrv.walletBalance, 20000);
  assert.equal(staleDrv.activeJobId, null);

  const ledger = await read(ledgerRef(jobId, offerId));
  assert.equal(ledger, undefined);
});

// =========================================================================
// D. Wallet Contention (Zero Overdraft)
// =========================================================================
test('D. wallet contention: driver cannot be overdrawn below 0 by concurrent operations', async () => {
  const driverId = 'driver_contention';
  // Driver has exactly 5000 paise
  await seedDriver(driverId, { walletBalance: 5000 });

  const jobId1 = 'job_contend_1';
  const offerId1 = 'offer_contend_1';
  await seedOfferedJobAndRun({ jobId: jobId1, driverId, offerId: offerId1, commissionPaise: 5000 });

  const manager = createAcceptJobManager({ db, TimestampClass: T, now });

  // Run acceptJob concurrently with a direct transaction trying to debit the same wallet
  const results = await Promise.allSettled([
    manager.acceptJob({ jobId: jobId1, offerId: offerId1, driverUid: driverId }),
    db.runTransaction(async tx => {
      const snap = await tx.get(driverRef(driverId));
      const bal = snap.data().walletBalance;
      if (bal < 5000) throw new Error('INSUFFICIENT_FUNDS');
      tx.update(driverRef(driverId), { walletBalance: bal - 5000 });
      return 'direct_debit_ok';
    }),
  ]);

  const succeededCount = results.filter(r => r.status === 'fulfilled').length;
  assert.equal(succeededCount, 1, 'Exactly one concurrent debit must succeed');

  const drv = await read(driverRef(driverId));
  assert.equal(drv.walletBalance, 0, 'Wallet balance must be exactly 0, never negative');
});

// =========================================================================
// E. Active Job Race
// =========================================================================
test('E. active job race: driver cannot accept second job when already assigned to first', async () => {
  const driverId = 'driver_multi';
  await seedDriver(driverId, { walletBalance: 50000 });

  const jobId1 = 'job_multi_1';
  const offerId1 = 'offer_multi_1';
  await seedOfferedJobAndRun({ jobId: jobId1, driverId, offerId: offerId1, commissionPaise: 5000 });

  const jobId2 = 'job_multi_2';
  const offerId2 = 'offer_multi_2';
  // Seed second job
  await seedOfferedJobAndRun({ jobId: jobId2, driverId, offerId: offerId2, commissionPaise: 5000 });
  // Driver's activeOfferId points to offerId1 for the test
  await driverRef(driverId).update({ activeOfferId: offerId1 });

  const manager = createAcceptJobManager({ db, TimestampClass: T, now });

  // Concurrently attempt to accept both jobs with Promise.allSettled
  const results = await Promise.allSettled([
    manager.acceptJob({ jobId: jobId1, offerId: offerId1, driverUid: driverId }),
    manager.acceptJob({ jobId: jobId2, offerId: offerId2, driverUid: driverId }),
  ]);

  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');

  assert.equal(successes.length, 1, 'Exactly one job acceptance must succeed');
  assert.equal(failures.length, 1, 'Concurrent acceptance of second job must fail');
  assert.ok(
    failures[0].reason.code === 'ACTIVE_JOB_CONFLICT' ||
    failures[0].reason.code === 'DRIVER_ENGAGEMENT_MISMATCH',
    'Failure code must indicate active job or engagement conflict'
  );

  const winningJobId = successes[0].value.jobId;
  const drv = await read(driverRef(driverId));
  assert.equal(drv.activeJobId, winningJobId, 'Driver must retain activeJobId for the winning job only');
  assert.equal(drv.walletBalance, 45000, 'Driver must only be debited once for the winning job');
});

// =========================================================================
// F. Accepted State Then Timeout Task
// =========================================================================
test('F. accepted state then timeout task: timeout safely no-ops with zero rollback', async () => {
  const jobId = 'job_f';
  const driverId = 'driver_f';
  const offerId = 'offer_f';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });
  const timeoutManager = createOfferTimeoutManager({ db, TimestampClass: T, now });

  // 1. Accept succeeds
  const acceptRes = await acceptManager.acceptJob({ jobId, offerId, driverUid: driverId });
  assert.equal(acceptRes.accepted, true);

  // 2. Later, timeout task fires (e.g. after expiry)
  clock += 60000;
  const timeoutRes = await timeoutManager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: 1, triggerCascade: false });

  // Timeout should recognize offer is not pending and no-op safely
  assert.equal(timeoutRes.expired, false);

  // Verify accepted state is completely preserved
  const job = await read(jobRef(jobId));
  const offer = await read(offerRef(offerId));
  const drv = await read(driverRef(driverId));

  assert.equal(job.status, 'accepted');
  assert.equal(job.assignedDriver, driverId);
  assert.equal(offer.status, 'accepted');
  assert.equal(drv.activeJobId, jobId);
  assert.equal(drv.walletBalance, 15000);
});

// =========================================================================
// G. Timeout Then Accept
// =========================================================================
test('G. timeout then accept: accept is rejected with zero wallet writes and zero ledger entry', async () => {
  const jobId = 'job_g';
  const driverId = 'driver_g';
  const offerId = 'offer_g';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });
  const timeoutManager = createOfferTimeoutManager({ db, TimestampClass: T, now });

  // 1. Advance clock past expiry and run timeout
  clock += 45000;
  const timeoutRes = await timeoutManager.expireOfferTimeout({ jobId, offerId, dispatchGeneration: 1, triggerCascade: false });
  assert.equal(timeoutRes.expired, true);

  // 2. Driver attempts to accept after timeout committed
  await assert.rejects(
    () => acceptManager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'JOB_NOT_OFFERED' || err.code === 'OFFER_NOT_ACTIVE' || err.code === 'OFFER_EXPIRED'
  );

  // Verify zero wallet writes and no ledger
  const drv = await read(driverRef(driverId));
  assert.equal(drv.walletBalance, 20000, 'Wallet balance must be completely untouched');
  assert.equal(drv.activeJobId, null);

  const ledger = await read(ledgerRef(jobId, offerId));
  assert.equal(ledger, undefined, 'Ledger entry must not exist');
});

// =========================================================================
// H. Clean Job Lifecycle Before Acceptance (Blocker 3 Real Emulator Regression)
// =========================================================================
test('H. offered job with inProgressAt/completedAt fails on real emulator with zero wallet/ledger/outbox writes', async () => {
  const jobId = 'job_h';
  const driverId = 'driver_h';
  const offerId = 'offer_h';

  await seedDriver(driverId, { walletBalance: 20000 });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  // Corrupt offered job with completedAt
  await jobRef(jobId).update({
    completedAt: T.fromMillis(clock),
  });

  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });

  await assert.rejects(
    () => acceptManager.acceptJob({ jobId, offerId, driverUid: driverId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );

  // Assert ZERO wallet mutation
  const drv = await read(driverRef(driverId));
  assert.equal(drv.walletBalance, 20000, 'Driver wallet balance must remain completely untouched');
  assert.equal(drv.activeJobId, null, 'Driver must not have active job');

  // Assert ZERO ledger entry
  const ledger = await read(ledgerRef(jobId, offerId));
  assert.equal(ledger, undefined, 'Commission ledger must NOT be written');

  // Assert ZERO outbox document
  const outboxDoc = await read(outboxRef(jobId, offerId));
  assert.equal(outboxDoc, undefined, 'Notification outbox must NOT be written');
});

// =========================================================================
// I. Confirmed Refund Amount Clean State Guard (P1 Real Emulator Regression)
// =========================================================================
test('I. P1 Blocker: confirmed refund amount (refundedAmountPaise = 10000) fails on real Firestore with zero mutations', async () => {
  const jobId = 'job_sol_p1';
  const driverId = 'driver_sol_p1';
  const offerId = 'offer_sol_p1';
  const requestId = 'req_sol_p1';

  await seedDriver(driverId, { walletBalance: 25000, activeOfferId: offerId });
  await seedOfferedJobAndRun({ jobId, driverId, offerId, commissionPaise: 5000 });

  // Sol exact reproduction: set ONLY job.refundedAmountPaise = 10000
  await jobRef(jobId).update({
    refundedAmountPaise: 10000,
  });

  const receiptRef = db.doc('processed_requests/' + requestId);

  // Capture complete before-state across all authoritative resources
  const jobBefore = await read(jobRef(jobId));
  const offerBefore = await read(offerRef(offerId));
  const runBefore = await read(runRef(jobId, 1));
  const driverBefore = await read(driverRef(driverId));

  const acceptManager = createAcceptJobManager({ db, TimestampClass: T, now });

  // Invoke actual production acceptJob manager
  await assert.rejects(
    () => acceptManager.acceptJob({ jobId, offerId, driverUid: driverId, requestId }),
    err => err.code === 'ACCEPTANCE_CONFLICT'
  );

  // 1. Assert wallet remains 25000 and driver unchanged
  const driverAfter = await read(driverRef(driverId));
  assert.equal(driverAfter.walletBalance, 25000, 'Driver wallet balance must remain exactly 25000');
  assert.deepEqual(driverAfter, driverBefore, 'Driver document must be completely unchanged');

  // 2. Assert job unchanged
  const jobAfter = await read(jobRef(jobId));
  assert.equal(jobAfter.refundedAmountPaise, 10000, 'refundedAmountPaise remains untouched');
  assert.equal(jobAfter.status, 'offered', 'Job status must remain offered');
  assert.deepEqual(jobAfter, jobBefore, 'Job document must be completely unchanged');

  // 3. Assert offer unchanged
  const offerAfter = await read(offerRef(offerId));
  assert.equal(offerAfter.status, 'offered', 'Offer status must remain offered');
  assert.deepEqual(offerAfter, offerBefore, 'Offer document must be completely unchanged');

  // 4. Assert run unchanged
  const runAfter = await read(runRef(jobId, 1));
  assert.deepEqual(runAfter, runBefore, 'Run document must be completely unchanged');

  // 5. Assert no commission ledger
  const ledger = await read(ledgerRef(jobId, offerId));
  assert.equal(ledger, undefined, 'Commission ledger must NOT exist');

  // 6. Assert no accepted outbox
  const outboxDoc = await read(outboxRef(jobId, offerId));
  assert.equal(outboxDoc, undefined, 'Accepted outbox must NOT exist');

  // 7. Assert no processed request
  const receiptDoc = await read(receiptRef);
  assert.equal(receiptDoc, undefined, 'Processed request receipt must NOT exist');
});

