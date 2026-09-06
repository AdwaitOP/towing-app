'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint } = require('firebase-admin/firestore');
const { createAcceptJobManager } = require('../../../firebase/functions/src/dispatch/acceptJob');
const { createDeclineJobManager } = require('../../../firebase/functions/src/dispatch/declineJob');
const { createOfferTimeoutManager } = require('../../../firebase/functions/src/dispatch/offerTimeout');
const { createJobLifecycleManager } = require('../../../firebase/functions/src/dispatch/jobLifecycle');
const { createWhatsAppWebhook } = require('../../../firebase/functions/src/messaging/whatsappWebhook');
const { paidJob, config, driver } = require('../fixtures');
const { POLICY_KEYS } = require('../../../firebase/functions/src/dispatch/dispatchValidation');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage6-lifecycle-test';
const app = initializeApp({ projectId: project }, 'stage6-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = (jobId, gen = 1) => db.doc('jobs/' + jobId + '/dispatch_runs/' + gen);
const driverRef = id => db.doc('drivers/' + id);
const ledgerRef = (jobId, offerId) => db.doc('wallet_entries/commission_debit:' + jobId + ':' + offerId);
const acceptedOutboxRef = (jobId, offerId) => db.doc('notification_outbox/job_accepted:' + jobId + ':' + offerId);
const inProgressOutboxRef = jobId => db.doc('notification_outbox/job_in_progress:' + jobId);
const completedOutboxRef = jobId => db.doc('notification_outbox/job_completed:' + jobId);
const requestRef = reqId => db.doc('processed_requests/' + reqId);

const read = async ref => (await ref.get()).data();
const exists = async ref => (await ref.get()).exists;

function createTestWebhook(sentMessages = []) {
  return createWhatsAppWebhook({
    db,
    TimestampClass: T,
    now: () => clock,
    env: { WHATSAPP_VERIFY_TOKEN: 'verify', WHATSAPP_APP_SECRET: 'secret' },
    verifySignatureFn: () => true,
    jobs: { createJobAndQuote: async () => assert.fail('should not create job') },
    whatsapp: {
      sendText: async (...args) => {
        sentMessages.push(args);
        return { messageId: 'out-' + Date.now() };
      },
    },
    razorpay: {
      getPaymentLinksByReferenceId: async () => [],
      getPaymentLink: async () => ({}),
      cancelPaymentLink: async () => ({}),
    },
  });
}

async function triggerCustomerCancellation(jobId, phone = '+919876543210', sentMessages = []) {
  await db.collection('whatsapp_sessions').doc(phone).set({
    phoneNumber: phone,
    state: 5,
    pickupCoords: { lat: 18.5204, lng: 73.8567 },
    destCoords: { lat: 18.55, lng: 73.88 },
    requestedTruckType: 'flatbed',
    jobId,
    pendingReply: null,
    lastProcessedMessageId: null,
  });

  const cancelMessage = {
    id: 'cancel-' + clock,
    from: phone.replace('+', ''),
    type: 'text',
    text: { body: 'CANCEL' },
  };
  const webhook = createTestWebhook(sentMessages);
  await webhook.processMessage(phone, cancelMessage, cancelMessage.id, 'owner-cancel-' + clock);
}

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

  return { jobId, driverId, offerId, generation };
}

async function setupAndAccept({
  jobId = 'job_1',
  driverId = 'driver_1',
  offerId = 'offer_1',
  acceptRequestId = 'req-accept-1',
} = {}) {
  await seedDriver(driverId);
  await seedOfferedJobAndRun({ jobId, driverId, offerId });

  const acceptMgr = createAcceptJobManager({ db, TimestampClass: T, now });
  clock += 1000;
  const acceptRes = await acceptMgr.acceptJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: acceptRequestId,
  });
  assert.equal(acceptRes.accepted, true);

  return { jobId, driverId, offerId, acceptRequestId };
}

// ════════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ════════════════════════════════════════════════════════════════════════════════

test('Test A: Mandatory Full Lifecycle Pipeline: acceptJob -> startJob -> completeJob', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();

  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // 1. Advance clock and run startJob
  clock += 5000;
  const startMs = clock;
  const startRes = await lifecycleMgr.startJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-start-1',
  });
  assert.deepEqual(startRes, { started: true, jobId, offerId, driverId });

  // Verify START state
  const jobAfterStart = await read(jobRef(jobId));
  assert.equal(jobAfterStart.status, 'in_progress');
  assert.equal(jobAfterStart.dispatchState, 'assigned');
  assert.equal(jobAfterStart.assignedDriver, driverId);
  assert.equal(jobAfterStart.currentOfferId, offerId);
  assert.equal(jobAfterStart.inProgressAt.toMillis(), startMs);
  assert.equal(jobAfterStart.stateVersion, 3); // 1 (offered) -> 2 (accepted) -> 3 (in_progress)

  const offerAfterStart = await read(offerRef(offerId));
  assert.equal(offerAfterStart.status, 'in_progress');
  assert.equal(offerAfterStart.inProgressAt.toMillis(), startMs);

  const runAfterStart = await read(runRef(jobId));
  assert.equal(runAfterStart.status, 'assigned');
  assert.equal(runAfterStart.finalizedAt, null);
  assert.equal(runAfterStart.candidates[0].outcome, 'accepted');

  const driverAfterStart = await read(driverRef(driverId));
  assert.equal(driverAfterStart.activeJobId, jobId);
  assert.equal(driverAfterStart.activeOfferId, null);
  assert.equal(driverAfterStart.walletBalance, 20000); // untouched

  const startOutbox = await read(inProgressOutboxRef(jobId));
  assert.ok(startOutbox);
  assert.equal(startOutbox.eventType, 'job_in_progress');
  assert.equal(startOutbox.resourceId, jobId);
  assert.equal(startOutbox.state, 'pending');
  assert.deepEqual(startOutbox.payload, { jobId, jobStatus: 'in_progress', refundAmountPaise: null });

  const startReceipt = await read(requestRef('req-start-1'));
  assert.ok(startReceipt);
  assert.equal(startReceipt.operation, 'start_job');
  assert.equal(startReceipt.status, 'completed');
  assert.equal(startReceipt.actorUid, driverId);

  // 2. Advance clock and run completeJob
  clock += 10000;
  const completeMs = clock;
  const completeRes = await lifecycleMgr.completeJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-complete-1',
  });
  assert.deepEqual(completeRes, { completed: true, jobId, offerId, driverId });

  // Verify COMPLETE state & All Pointer Contracts
  const jobAfterComplete = await read(jobRef(jobId));
  assert.equal(jobAfterComplete.status, 'completed');
  assert.equal(jobAfterComplete.dispatchState, 'closed');
  assert.equal(jobAfterComplete.assignedDriver, driverId); // preserved
  assert.equal(jobAfterComplete.currentOfferId, offerId); // preserved
  assert.equal(jobAfterComplete.dispatchRunId, '1'); // preserved
  assert.equal(jobAfterComplete.dispatchGeneration, 1); // preserved
  assert.equal(jobAfterComplete.completedAt.toMillis(), completeMs);
  assert.equal(jobAfterComplete.stateVersion, 4); // 3 -> 4

  const offerAfterComplete = await read(offerRef(offerId));
  assert.equal(offerAfterComplete.status, 'completed');
  assert.equal(offerAfterComplete.completedAt.toMillis(), completeMs);

  const runAfterComplete = await read(runRef(jobId));
  assert.equal(runAfterComplete.status, 'completed');
  assert.equal(runAfterComplete.currentOfferId, offerId); // preserved
  assert.equal(runAfterComplete.candidates[0].outcome, 'accepted'); // preserved
  assert.equal(runAfterComplete.finalizedAt.toMillis(), completeMs);

  const driverAfterComplete = await read(driverRef(driverId));
  assert.equal(driverAfterComplete.activeJobId, null); // released!
  assert.equal(driverAfterComplete.activeOfferId, null);
  assert.equal(driverAfterComplete.walletBalance, 20000); // untouched

  const completeOutbox = await read(completedOutboxRef(jobId));
  assert.ok(completeOutbox);
  assert.equal(completeOutbox.eventType, 'job_completed');
  assert.equal(completeOutbox.resourceId, jobId);
  assert.equal(completeOutbox.state, 'pending');
  assert.deepEqual(completeOutbox.payload, { jobId, jobStatus: 'completed', refundAmountPaise: null });

  const completeReceipt = await read(requestRef('req-complete-1'));
  assert.ok(completeReceipt);
  assert.equal(completeReceipt.operation, 'complete_job');
  assert.equal(completeReceipt.status, 'completed');
  assert.equal(completeReceipt.actorUid, driverId);
});

test('Test B: Duplicate Start Same requestId (concurrent race safety)', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });
  clock += 2000;

  // 5 concurrent start calls with identical requestId
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      lifecycleMgr.startJob({
        jobId,
        offerId,
        driverUid: driverId,
        requestId: 'req-start-race',
      })
    )
  );

  for (const res of results) {
    assert.equal(res.started, true);
    assert.equal(res.jobId, jobId);
    assert.equal(res.offerId, offerId);
    assert.equal(res.driverId, driverId);
  }

  // Verify exactly one outbox and stateVersion incremented exactly once
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'in_progress');
  assert.equal(job.stateVersion, 3);

  const outbox = await read(inProgressOutboxRef(jobId));
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_in_progress');

  const receipt = await read(requestRef('req-start-race'));
  assert.ok(receipt);
  assert.equal(receipt.status, 'completed');
});

test('Test C: Duplicate Complete Same requestId (concurrent race safety)', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });
  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  clock += 5000;
  // 5 concurrent complete calls with identical requestId
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      lifecycleMgr.completeJob({
        jobId,
        offerId,
        driverUid: driverId,
        requestId: 'req-complete-race',
      })
    )
  );

  for (const res of results) {
    assert.equal(res.completed, true);
    assert.equal(res.jobId, jobId);
    assert.equal(res.offerId, offerId);
    assert.equal(res.driverId, driverId);
  }

  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'completed');
  assert.equal(job.dispatchState, 'closed');
  assert.equal(job.stateVersion, 4);

  const run = await read(runRef(jobId));
  assert.equal(run.status, 'completed');
  assert.equal(run.finalizedAt.toMillis(), job.completedAt.toMillis());

  const driverDoc = await read(driverRef(driverId));
  assert.equal(driverDoc.activeJobId, null);

  const outbox = await read(completedOutboxRef(jobId));
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'job_completed');
});

test('Test D1: Start vs Customer Cancellation: Cancellation committed FIRST -> start fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Customer cancellation arrives and commits first via production WhatsApp webhook
  clock += 2000;
  await triggerCustomerCancellation(jobId);

  const beforeJob = await read(jobRef(jobId));
  const beforeOffer = await read(offerRef(offerId));
  const beforeRun = await read(runRef(jobId));
  const beforeDriver = await read(driverRef(driverId));

  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-after-cancel' }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );

  // Verify zero state change on job, offer, run, driver; no outbox created
  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.deepEqual(await read(offerRef(offerId)), beforeOffer);
  assert.deepEqual(await read(runRef(jobId)), beforeRun);
  assert.deepEqual(await read(driverRef(driverId)), beforeDriver);
  assert.equal(await exists(inProgressOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-start-after-cancel')), false);
});

test('Test D2: Start vs Customer Cancellation: Start committed FIRST -> in_progress accepts cancellation marker', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Driver start commits first
  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-first' });

  const jobAfterStart = await read(jobRef(jobId));
  assert.equal(jobAfterStart.status, 'in_progress');

  // Customer cancellation marker now arrives against in_progress job via production webhook
  clock += 1000;
  await triggerCustomerCancellation(jobId);

  const jobWithCancel = await read(jobRef(jobId));
  assert.equal(jobWithCancel.status, 'in_progress');
  assert.equal(jobWithCancel.cancelledBy, 'customer');
  assert.ok(jobWithCancel.cancellationRequestedAt);
});

test('Test E1: Complete vs Customer Cancellation: Cancellation committed FIRST -> complete fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  // Customer cancellation arrives while in_progress via production webhook
  clock += 2000;
  await triggerCustomerCancellation(jobId);

  const beforeJob = await read(jobRef(jobId));
  const beforeOffer = await read(offerRef(offerId));
  const beforeRun = await read(runRef(jobId));
  const beforeDriver = await read(driverRef(driverId));

  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-after-cancel' }),
    err => err.code === 'CANCELLATION_PRECEDENCE'
  );

  // Zero writes: status remains in_progress, driver not released, no completed outbox
  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.deepEqual(await read(offerRef(offerId)), beforeOffer);
  assert.deepEqual(await read(runRef(jobId)), beforeRun);
  assert.deepEqual(await read(driverRef(driverId)), beforeDriver);
  assert.equal(await exists(completedOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-complete-after-cancel')), false);
});

test('Test E2: Complete vs Customer Cancellation: Complete committed FIRST -> job terminal, cancellation rejected', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-first' });

  const jobBefore = await read(jobRef(jobId));
  assert.equal(jobBefore.status, 'completed');
  assert.equal(jobBefore.dispatchState, 'closed');
  const run = await read(runRef(jobId));
  assert.equal(run.status, 'completed');
  assert.ok(run.finalizedAt);

  // Customer cancellation arrives after completion via production webhook
  clock += 1000;
  const sentReplies = [];
  await triggerCustomerCancellation(jobId, '+919876543210', sentReplies);

  // Verify completed job in Firestore is COMPLETELY UNTOUCHED
  const jobAfter = await read(jobRef(jobId));
  assert.deepEqual(jobAfter, jobBefore);

  // Verify customer receives "already completed and cannot be cancelled" reply
  assert.ok(sentReplies.length > 0);
  assert.match(sentReplies[0][1], /already completed and cannot be cancelled/);

  // Verify completed state is terminal and cannot be modified by subsequent lifecycle actions
  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-after-complete' }),
    err => err.code === 'JOB_NOT_ACCEPTED'
  );
});

test('Test F: Start Retry After Complete: returns idempotent success with 0 writes and job remains completed', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const beforeJob = await read(jobRef(jobId));
  const beforeOffer = await read(offerRef(offerId));
  const beforeRun = await read(runRef(jobId));
  const beforeDriver = await read(driverRef(driverId));

  // Retry startJob with original requestId
  clock += 2000;
  const retryRes = await lifecycleMgr.startJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-start-1',
  });
  assert.equal(retryRes.started, true);
  assert.equal(retryRes.idempotent, true);
  assert.equal(retryRes.jobId, jobId);
  assert.equal(retryRes.offerId, offerId);
  assert.equal(retryRes.driverId, driverId);

  // Verify zero state changes
  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.deepEqual(await read(offerRef(offerId)), beforeOffer);
  assert.deepEqual(await read(runRef(jobId)), beforeRun);
  assert.deepEqual(await read(driverRef(driverId)), beforeDriver);
});

test('Test G: Complete Retry: returns idempotent success with 0 writes, finalizedAt unchanged', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const beforeJob = await read(jobRef(jobId));
  const beforeRun = await read(runRef(jobId));

  // Retry completeJob with same requestId
  clock += 3000;
  const retryRes = await lifecycleMgr.completeJob({
    jobId,
    offerId,
    driverUid: driverId,
    requestId: 'req-complete-1',
  });
  assert.equal(retryRes.completed, true);
  assert.equal(retryRes.idempotent, true);
  assert.equal(retryRes.jobId, jobId);
  assert.equal(retryRes.offerId, offerId);
  assert.equal(retryRes.driverId, driverId);

  const afterJob = await read(jobRef(jobId));
  const afterRun = await read(runRef(jobId));
  assert.deepEqual(afterJob, beforeJob);
  assert.deepEqual(afterRun, beforeRun);
  assert.equal(afterJob.completedAt.toMillis(), beforeJob.completedAt.toMillis());
  assert.equal(afterRun.finalizedAt.toMillis(), beforeRun.finalizedAt.toMillis());
});

test('Test H: Different requestId after start fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-A' });

  const beforeJob = await read(jobRef(jobId));
  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-B' }),
    err => err.code === 'JOB_NOT_ACCEPTED' || err.code === 'OFFER_NOT_ACCEPTED'
  );

  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.equal(await exists(requestRef('req-start-B')), false);
});

test('Test I: Different requestId after complete fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-A' });

  const beforeJob = await read(jobRef(jobId));
  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-B' }),
    err => err.code === 'JOB_NOT_IN_PROGRESS' || err.code === 'OFFER_NOT_IN_PROGRESS'
  );

  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.equal(await exists(requestRef('req-complete-B')), false);
});

test('Test J: Corrupt Accepted Provenance on Real Emulator fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // J1: Missing commission debit ledger
  await ledgerRef(jobId, offerId).delete();
  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-corrupt' }),
    err => err.code === 'LEDGER_INVALID' || err.code === 'ACCEPTANCE_CONFLICT'
  );

  // Restore ledger, J2: corrupt outbox payload
  await ledgerRef(jobId, offerId).set({
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
    sourceRequestId: 'req-accept-1',
    sourceType: 'driver',
    actorUid: driverId,
    createdAt: T.fromMillis(clock - 1000),
  });

  await acceptedOutboxRef(jobId, offerId).update({ state: 'illegal_state' });
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-corrupt' }),
    err => err.code === 'OUTBOX_INVALID' || err.code === 'ACCEPTANCE_CONFLICT'
  );
});

test('Test K: Corrupt In-Progress Provenance on Real Emulator fails closed with 0 writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  // K1: Delete in-progress outbox
  await inProgressOutboxRef(jobId).delete();
  clock += 1000;
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-corrupt' }),
    err => err.code === 'OUTBOX_INVALID' || err.code === 'IN_PROGRESS_CONFLICT'
  );

  // Restore outbox, K2: driver activeJobId mismatch
  await inProgressOutboxRef(jobId).set({
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
    nextAttemptAt: T.fromMillis(clock),
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: T.fromMillis(clock),
    updatedAt: T.fromMillis(clock),
    sentAt: null,
  });

  await driverRef(driverId).update({ activeJobId: 'other_job' });
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-corrupt' }),
    err => err.code === 'DRIVER_ENGAGEMENT_MISMATCH'
  );
});

test('Test L: Completion Terminality: stale timeout, decline, accept, start fail closed against completed state', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });
  const declineMgr = createDeclineJobManager({ db, TimestampClass: T, now });
  const timeoutMgr = createOfferTimeoutManager({ db, TimestampClass: T, now });
  const acceptMgr = createAcceptJobManager({ db, TimestampClass: T, now });

  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });
  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  // 1. Stale offerTimeout returns no-op (expired: false)
  const timeoutRes = await timeoutMgr.expireOfferTimeout({
    jobId,
    offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });
  assert.equal(timeoutRes.expired, false);

  // 2. Decline fails closed
  await assert.rejects(
    () => declineMgr.declineJob({ jobId, offerId, driverUid: driverId, requestId: 'req-decline-late' }),
    err => err.code === 'OFFER_NOT_ACTIVE'
  );

  // 3. Accept fails closed
  await assert.rejects(
    () => acceptMgr.acceptJob({ jobId, offerId, driverUid: driverId, requestId: 'req-accept-late' }),
    err => err.code === 'JOB_NOT_OFFERED' || err.code === 'JOB_OFFER_MISMATCH' || err.code === 'ACCEPTANCE_CONFLICT' || err.code === 'OFFER_EXPIRED'
  );

  // 4. Start with different requestId fails closed
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-late' }),
    err => err.code === 'JOB_NOT_ACCEPTED'
  );

  // 5. Complete with different requestId fails closed
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-late' }),
    err => err.code === 'JOB_NOT_IN_PROGRESS'
  );

  // Verify job remains completed
  const job = await read(jobRef(jobId));
  assert.equal(job.status, 'completed');
  assert.equal(job.dispatchState, 'closed');
});

test('Test M: Financial Immutability: zero balance change and zero new wallet entries on start/complete', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  const driverAfterAccept = await read(driverRef(driverId));
  assert.equal(driverAfterAccept.walletBalance, 20000);

  const walletEntriesAfterAccept = (await db.collection('wallet_entries').get()).size;
  assert.equal(walletEntriesAfterAccept, 1); // exactly the commission_debit entry

  // Start job
  clock += 2000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-1' });

  const driverAfterStart = await read(driverRef(driverId));
  assert.equal(driverAfterStart.walletBalance, 20000);
  const walletEntriesAfterStart = (await db.collection('wallet_entries').get()).size;
  assert.equal(walletEntriesAfterStart, 1); // still 1

  // Complete job
  clock += 5000;
  await lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-complete-1' });

  const driverAfterComplete = await read(driverRef(driverId));
  assert.equal(driverAfterComplete.walletBalance, 20000);
  const walletEntriesAfterComplete = (await db.collection('wallet_entries').get()).size;
  assert.equal(walletEntriesAfterComplete, 1); // still 1! Zero new financial entries.
});

test('Test N: Emulator Run Corruption: real Firestore transaction rejects corrupt run state with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Corrupt dispatch run in real Firestore: set invalid policyVersion
  await runRef(jobId).update({ policyVersion: 0 });

  const beforeJob = await read(jobRef(jobId));
  const beforeOffer = await read(offerRef(offerId));
  const beforeRun = await read(runRef(jobId));
  const beforeDriver = await read(driverRef(driverId));

  clock += 2000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-corrupt-run' }),
    err => err.code === 'RUN_INVALID'
  );

  // Assert complete zero-write isolation in Firestore
  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.deepEqual(await read(offerRef(offerId)), beforeOffer);
  assert.deepEqual(await read(runRef(jobId)), beforeRun);
  assert.deepEqual(await read(driverRef(driverId)), beforeDriver);
  assert.equal(await exists(inProgressOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-start-corrupt-run')), false);
});

test('Test O: Emulator Outbox Corruption: real Firestore transaction rejects corrupt outbox record with zero writes', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Corrupt accepted outbox in real Firestore: attemptCount > 0 while state is pending
  await acceptedOutboxRef(jobId, offerId).update({ attemptCount: 2 });

  const beforeJob = await read(jobRef(jobId));
  const beforeOffer = await read(offerRef(offerId));
  const beforeRun = await read(runRef(jobId));
  const beforeDriver = await read(driverRef(driverId));

  clock += 2000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-corrupt-outbox' }),
    err => err.code === 'OUTBOX_INVALID'
  );

  // Assert complete zero-write isolation in Firestore
  assert.deepEqual(await read(jobRef(jobId)), beforeJob);
  assert.deepEqual(await read(offerRef(offerId)), beforeOffer);
  assert.deepEqual(await read(runRef(jobId)), beforeRun);
  assert.deepEqual(await read(driverRef(driverId)), beforeDriver);
  assert.equal(await exists(inProgressOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-start-corrupt-outbox')), false);
});

test('Test P: Emulator Blocker 1 Shortlist Cap Corruption Probe: real Firestore transaction rejects corrupt run shortlist cap with zero writes and updateTime equality', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // P1: startJob probe: 3 round-0 candidates, cap = 1 (Astra reproduction)
  const prev1 = 'driver_prev_p1';
  const prev2 = 'driver_prev_p2';
  const r0Candidates = [
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

  await offerRef(offerId).update({ candidateIndex: 2 });
  const runData = await read(runRef(jobId));
  await runRef(jobId).update({
    candidates: r0Candidates,
    attemptedDriverIds: [prev1, prev2, driverId],
    nextCandidateIndex: 3,
    policySnapshot: {
      ...runData.policySnapshot,
      maxMatrixShortlistPerRound: 1,
    },
  });

  const jobSnapBefore = await jobRef(jobId).get();
  const offerSnapBefore = await offerRef(offerId).get();
  const runSnapBefore = await runRef(jobId).get();
  const driverSnapBefore = await driverRef(driverId).get();

  clock += 2000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-p1-cap' }),
    err => err.code === 'RUN_INVALID'
  );

  // Assert exact before/after data equality AND updateTime equality on all entities
  const jobSnapAfter = await jobRef(jobId).get();
  const offerSnapAfter = await offerRef(offerId).get();
  const runSnapAfter = await runRef(jobId).get();
  const driverSnapAfter = await driverRef(driverId).get();

  assert.deepEqual(jobSnapAfter.data(), jobSnapBefore.data());
  assert.deepEqual(offerSnapAfter.data(), offerSnapBefore.data());
  assert.deepEqual(runSnapAfter.data(), runSnapBefore.data());
  assert.deepEqual(driverSnapAfter.data(), driverSnapBefore.data());

  assert.equal(jobSnapAfter.updateTime.isEqual(jobSnapBefore.updateTime), true);
  assert.equal(offerSnapAfter.updateTime.isEqual(offerSnapBefore.updateTime), true);
  assert.equal(runSnapAfter.updateTime.isEqual(runSnapBefore.updateTime), true);
  assert.equal(driverSnapAfter.updateTime.isEqual(driverSnapBefore.updateTime), true);

  assert.equal(await exists(inProgressOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-start-p1-cap')), false);

  // P2: completeJob probe: start legally under cap = 10, then corrupt cap = 1
  await runRef(jobId).update({
    'policySnapshot.maxMatrixShortlistPerRound': 10,
  });
  clock += 1000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-p2-legit' });

  // Corrupt cap = 1 while 3 candidates exist in round 0
  await runRef(jobId).update({
    'policySnapshot.maxMatrixShortlistPerRound': 1,
  });

  const cJobSnapBefore = await jobRef(jobId).get();
  const cOfferSnapBefore = await offerRef(offerId).get();
  const cRunSnapBefore = await runRef(jobId).get();
  const cDriverSnapBefore = await driverRef(driverId).get();

  clock += 3000;
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-p2-cap' }),
    err => err.code === 'RUN_INVALID'
  );

  const cJobSnapAfter = await jobRef(jobId).get();
  const cOfferSnapAfter = await offerRef(offerId).get();
  const cRunSnapAfter = await runRef(jobId).get();
  const cDriverSnapAfter = await driverRef(driverId).get();

  assert.deepEqual(cJobSnapAfter.data(), cJobSnapBefore.data());
  assert.deepEqual(cOfferSnapAfter.data(), cOfferSnapBefore.data());
  assert.deepEqual(cRunSnapAfter.data(), cRunSnapBefore.data());
  assert.deepEqual(cDriverSnapAfter.data(), cDriverSnapBefore.data());

  assert.equal(cJobSnapAfter.updateTime.isEqual(cJobSnapBefore.updateTime), true);
  assert.equal(cOfferSnapAfter.updateTime.isEqual(cOfferSnapBefore.updateTime), true);
  assert.equal(cRunSnapAfter.updateTime.isEqual(cRunSnapBefore.updateTime), true);
  assert.equal(cDriverSnapAfter.updateTime.isEqual(cDriverSnapBefore.updateTime), true);

  assert.equal(await exists(completedOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-comp-p2-cap')), false);
});

test('Test Q: Emulator Blocker 2 Excluded Driver Probe: real Firestore transaction rejects accepted driver in excludedDriverIds with zero writes and updateTime equality', async () => {
  const { jobId, driverId, offerId } = await setupAndAccept();
  const lifecycleMgr = createJobLifecycleManager({ db, TimestampClass: T, now });

  // Q1: startJob probe: corrupt run.excludedDriverIds = [driverId]
  await runRef(jobId).update({
    excludedDriverIds: [driverId],
  });

  const jobSnapBefore = await jobRef(jobId).get();
  const offerSnapBefore = await offerRef(offerId).get();
  const runSnapBefore = await runRef(jobId).get();
  const driverSnapBefore = await driverRef(driverId).get();

  clock += 2000;
  await assert.rejects(
    () => lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-q1-excl' }),
    err => err.code === 'RUN_INVALID'
  );

  const jobSnapAfter = await jobRef(jobId).get();
  const offerSnapAfter = await offerRef(offerId).get();
  const runSnapAfter = await runRef(jobId).get();
  const driverSnapAfter = await driverRef(driverId).get();

  assert.deepEqual(jobSnapAfter.data(), jobSnapBefore.data());
  assert.deepEqual(offerSnapAfter.data(), offerSnapBefore.data());
  assert.deepEqual(runSnapAfter.data(), runSnapBefore.data());
  assert.deepEqual(driverSnapAfter.data(), driverSnapBefore.data());

  assert.equal(jobSnapAfter.updateTime.isEqual(jobSnapBefore.updateTime), true);
  assert.equal(offerSnapAfter.updateTime.isEqual(offerSnapBefore.updateTime), true);
  assert.equal(runSnapAfter.updateTime.isEqual(runSnapBefore.updateTime), true);
  assert.equal(driverSnapAfter.updateTime.isEqual(driverSnapBefore.updateTime), true);

  assert.equal(await exists(inProgressOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-start-q1-excl')), false);

  // Q2: completeJob probe: restore excludedDriverIds: [], start legally, then corrupt excludedDriverIds = [driverId]
  await runRef(jobId).update({
    excludedDriverIds: [],
  });
  clock += 1000;
  await lifecycleMgr.startJob({ jobId, offerId, driverUid: driverId, requestId: 'req-start-q2-legit' });

  // Corrupt excludedDriverIds on in_progress run
  await runRef(jobId).update({
    excludedDriverIds: [driverId],
  });

  const cJobSnapBefore = await jobRef(jobId).get();
  const cOfferSnapBefore = await offerRef(offerId).get();
  const cRunSnapBefore = await runRef(jobId).get();
  const cDriverSnapBefore = await driverRef(driverId).get();

  clock += 3000;
  await assert.rejects(
    () => lifecycleMgr.completeJob({ jobId, offerId, driverUid: driverId, requestId: 'req-comp-q2-excl' }),
    err => err.code === 'RUN_INVALID'
  );

  const cJobSnapAfter = await jobRef(jobId).get();
  const cOfferSnapAfter = await offerRef(offerId).get();
  const cRunSnapAfter = await runRef(jobId).get();
  const cDriverSnapAfter = await driverRef(driverId).get();

  assert.deepEqual(cJobSnapAfter.data(), cJobSnapBefore.data());
  assert.deepEqual(cOfferSnapAfter.data(), cOfferSnapBefore.data());
  assert.deepEqual(cRunSnapAfter.data(), cRunSnapBefore.data());
  assert.deepEqual(cDriverSnapAfter.data(), cDriverSnapBefore.data());

  assert.equal(cJobSnapAfter.updateTime.isEqual(cJobSnapBefore.updateTime), true);
  assert.equal(cOfferSnapAfter.updateTime.isEqual(cOfferSnapBefore.updateTime), true);
  assert.equal(cRunSnapAfter.updateTime.isEqual(cRunSnapBefore.updateTime), true);
  assert.equal(cDriverSnapAfter.updateTime.isEqual(cDriverSnapBefore.updateTime), true);

  assert.equal(await exists(completedOutboxRef(jobId)), false);
  assert.equal(await exists(requestRef('req-comp-q2-excl')), false);
});
