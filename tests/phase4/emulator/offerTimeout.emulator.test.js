'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint, FieldPath } = require('firebase-admin/firestore');
const { createDispatchService, offerIdFor } = require('../../../firebase/functions/src/dispatch/dispatchService');
const {
  createDispatchRecovery,
  compareTimestamp,
  compareDocumentId,
  isAuthoritativeTimestamp,
  isLegalDocumentId,
  compareTuples,
  validateRecoveryCheckpoint,
  getOrBootstrapCheckpoint,
} = require('../../../firebase/functions/src/dispatch/dispatchRecovery');
const { createOfferTimeoutManager } = require('../../../firebase/functions/src/dispatch/offerTimeout');
const { createTaskQueueService, taskIdForOfferTimeout } = require('../../../firebase/functions/src/services/taskQueueService');
const { paidJob, config, driver } = require('../fixtures');
const { FakeTaskQueue } = require('../fakeDeps');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) throw new Error('A loopback Firestore Emulator is mandatory');
const project = 'towing-stage3-timeout-cascade';
const app = initializeApp({ projectId: project }, 'stage3-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);
const jobRef = id => db.doc('jobs/' + id);
const offerRef = id => db.doc('job_offers/' + id);
const runRef = id => db.doc('jobs/' + id + '/dispatch_runs/1');
const driverRef = id => db.doc('drivers/' + id);
const read = async ref => (await ref.get()).data();

test.beforeEach(async () => {
  clock = Date.parse('2026-09-02T10:00:00Z');
  const response = await fetch('http://' + host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
  assert.equal(response.ok, true);
  await db.doc('dispatch_config/main').set(config(T, clock));
});

test.after(async () => {
  await db.terminate();
  await app.delete();
});

async function seedJob(id = 'job', patch = {}) {
  const job = paidJob(T, clock, patch);
  await jobRef(id).set(job);
  return job;
}

async function seedDriver(id = 'driver', patch = {}) {
  await driverRef(id).set(driver(T, clock, { location: new GeoPoint(18.525, 73.86), ...patch }));
}

test('1. timeout atomicity across job, offer, driver, and run', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });

  const dispatchResult = await service.processDispatchJob('job_1');
  assert.equal(dispatchResult.dispatched, true);
  const offerId = dispatchResult.offerId;

  // Advance time past 45 seconds
  clock += 45000;

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service, taskQueueService });
  const expireResult = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId,
    dispatchGeneration: 1,
    triggerCascade: false, // Isolate atomic mutation for inspection
  });

  assert.equal(expireResult.expired, true);
  assert.equal(expireResult.jobId, 'job_1');
  assert.equal(expireResult.offerId, offerId);
  assert.equal(expireResult.driverId, 'driver_1');

  const job = await read(jobRef('job_1'));
  const offer = await read(offerRef(offerId));
  const driverDoc = await read(driverRef('driver_1'));
  const run = await read(runRef('job_1'));

  // Job checks
  assert.equal(job.status, 'pending_offer');
  assert.equal(job.dispatchState, 'ready');
  assert.equal(job.offeredTo, null);
  assert.equal(job.currentOfferId, null);
  assert.equal(job.offeredAt, null);
  assert.equal(job.offerExpiresAt, null);
  assert.equal(job.stateVersion, 2);
  assert.equal(job.dispatchGeneration, 1);

  // Offer checks
  assert.equal(offer.status, 'expired');
  assert.equal(offer.resolutionReason, 'offer_expired');
  assert.equal(offer.resolvedAt.toMillis(), clock);

  // Driver checks
  assert.equal(driverDoc.activeOfferId, null);

  // Run checks
  assert.equal(run.status, 'active');
  assert.equal(run.finalizedAt, null);
  assert.equal(run.currentOfferId, null);
  assert.equal(run.candidates[0].outcome, 'expired');
});

test('2 & 3. timeout preserves nextCandidateIndex and attemptedDriverIds exactly', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });

  const dispatchResult = await service.processDispatchJob('job_1');
  const runBefore = await read(runRef('job_1'));
  assert.equal(runBefore.nextCandidateIndex, 1);
  assert.deepEqual(runBefore.attemptedDriverIds, ['driver_1']);

  clock += 45000;
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });

  const runAfter = await read(runRef('job_1'));
  assert.equal(runAfter.nextCandidateIndex, 1); // Strictly UNCHANGED
  assert.deepEqual(runAfter.attemptedDriverIds, ['driver_1']); // Strictly UNCHANGED
});

test('4. same-generation next-driver cascade: Offer 1 timeout triggers Offer 2', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });

  // Initial dispatch -> offers driver_1
  const dispatch1 = await service.processDispatchJob('job_1');
  assert.equal(dispatch1.dispatched, true);
  assert.equal(dispatch1.driverId, 'driver_1');
  assert.equal((await read(driverRef('driver_1'))).activeOfferId, dispatch1.offerId);

  // Driver 1 times out after 45s -> cascades to driver_2
  clock += 45000;
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service, taskQueueService });
  const expireResult = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatch1.offerId,
    dispatchGeneration: 1,
    triggerCascade: true,
  });

  assert.equal(expireResult.expired, true);

  // Job should now be offered to driver_2
  const job = await read(jobRef('job_1'));
  assert.equal(job.status, 'offered');
  assert.equal(job.offeredTo, 'driver_2');

  const driver1Doc = await read(driverRef('driver_1'));
  const driver2Doc = await read(driverRef('driver_2'));
  assert.equal(driver1Doc.activeOfferId, null);
  assert.equal(driver2Doc.activeOfferId, job.currentOfferId);

  const offer1 = await read(offerRef(dispatch1.offerId));
  const offer2 = await read(offerRef(job.currentOfferId));
  assert.equal(offer1.status, 'expired');
  assert.equal(offer2.status, 'offered');
  assert.equal(offer2.driverId, 'driver_2');

  const run = await read(runRef('job_1'));
  assert.equal(run.candidates[0].outcome, 'expired');
  assert.equal(run.candidates[1].outcome, 'offered');
  assert.deepEqual(run.attemptedDriverIds, ['driver_1', 'driver_2']);
});

test('5 & 6. multi-driver cascade to finite exhaustion creates refund intent exactly once', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service, taskQueueService });

  // 1. Initial dispatch -> Driver 1
  const d1 = await service.processDispatchJob('job_1');
  assert.equal(d1.dispatched, true);

  // 2. Driver 1 timeout -> cascades to Driver 2
  clock += 45000;
  const e1 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: d1.offerId,
    dispatchGeneration: 1,
    triggerCascade: true,
  });
  assert.equal(e1.expired, true);
  const jobAfterE1 = await read(jobRef('job_1'));
  assert.equal(jobAfterE1.status, 'offered');
  assert.equal(jobAfterE1.offeredTo, 'driver_2');

  // 3. Driver 2 timeout -> cascades to exhaustion!
  clock += 45000;
  const e2 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: jobAfterE1.currentOfferId,
    dispatchGeneration: 1,
    triggerCascade: true,
  });
  assert.equal(e2.expired, true);

  // Job should now be cancelled_system with no_driver_found
  const jobTerminal = await read(jobRef('job_1'));
  assert.equal(jobTerminal.status, 'cancelled_system');
  assert.equal(jobTerminal.dispatchState, 'closed');
  assert.equal(jobTerminal.cancelledBy, 'system');
  assert.equal(jobTerminal.cancellationReason, 'no_driver_found');

  const runTerminal = await read(runRef('job_1'));
  assert.equal(runTerminal.status, 'exhausted');
  assert.ok(runTerminal.finalizedAt);
  assert.equal(runTerminal.candidates[0].outcome, 'expired');
  assert.equal(runTerminal.candidates[1].outcome, 'expired');

  // Refund request must be created atomically
  const refundReq = await read(db.doc('refund_requests/job_1'));
  assert.equal(refundReq.jobId, 'job_1');
  assert.equal(refundReq.amountPaise, 10000);
  assert.equal(refundReq.reason, 'no_driver_found');
  assert.equal(refundReq.providerIdempotencyKey, 'refund_no_driver_found_job_1');
  assert.equal(refundReq.state, 'pending');
});

test('7. Crash Window A: offer committed -> crash before task enqueue -> recovery enqueues same task', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  // Enqueue fails during initial dispatch
  const failingTaskQueue = {
    enqueueOfferTimeoutTask: async () => ({ enqueued: false, taskId: 'task_timeout_123', code: 'UNAVAILABLE' }),
  };
  const service = createDispatchService({ db, now, taskQueueService: failingTaskQueue });
  const dispatchResult = await service.processDispatchJob('job_1');
  assert.equal(dispatchResult.dispatched, true);

  const offerBefore = await read(offerRef(dispatchResult.offerId));
  assert.equal(offerBefore.timeoutTaskState, 'pending');
  assert.equal(offerBefore.timeoutTaskId, null);

  // Recovery runs with operational task queue before offer expires
  const workingQueue = new FakeTaskQueue();
  const operationalTaskQueue = createTaskQueueService({ functions: { taskQueue: () => workingQueue } });
  const recoveryService = createDispatchService({ db, now, taskQueueService: operationalTaskQueue });
  const recovery = createDispatchRecovery({
    db, now, service: recoveryService, taskQueueService: operationalTaskQueue,
  });

  const counts = await recovery.reconcileOfferTimeouts();
  assert.equal(counts.markerConverged, 1);

  const offerAfter = await read(offerRef(dispatchResult.offerId));
  assert.equal(offerAfter.timeoutTaskState, 'enqueued');
  const expectedTaskId = taskIdForOfferTimeout('job_1', dispatchResult.offerId, 1);
  assert.equal(offerAfter.timeoutTaskId, expectedTaskId);
  assert.equal(workingQueue.enqueuedTasks.length, 1);
  assert.equal(workingQueue.enqueuedTasks[0].options.id, expectedTaskId);
});

test('8. Crash Window B: task created -> crash before marker write -> recovery receives ALREADY_EXISTS -> marker converges', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });

  const dispatchResult = await service.processDispatchJob('job_1');
  const expectedTaskId = taskIdForOfferTimeout('job_1', dispatchResult.offerId, 1);

  // Simulate crash by resetting offer marker back to pending
  await offerRef(dispatchResult.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  // Task is already in fakeQueue from the first dispatch
  assert.ok(fakeQueue.taskMap.has(expectedTaskId));

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService });
  const counts = await recovery.reconcileOfferTimeouts();
  assert.equal(counts.markerConverged, 1);

  const offerAfter = await read(offerRef(dispatchResult.offerId));
  assert.equal(offerAfter.timeoutTaskState, 'enqueued');
  assert.equal(offerAfter.timeoutTaskId, expectedTaskId);
});

test('9. Crash Window C: task created -> offer resolves before marker write -> marker write no-ops -> stale task no-ops', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now, taskQueueService });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service, taskQueueService });

  const dispatchResult = await service.processDispatchJob('job_1');
  const expectedTaskId = taskIdForOfferTimeout('job_1', dispatchResult.offerId, 1);

  // Offer expires at T+45s
  clock += 45000;
  await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'expired');

  // Attempting delayed marker convergence on resolved offer cleanly no-ops
  const markerResult = await timeoutManager.convergeTaskMarker({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
    taskId: expectedTaskId,
  });
  assert.equal(markerResult.converged, false);
  assert.equal(markerResult.reason, 'OFFER_NOT_PENDING_ENQUEUE');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'expired');

  // Delayed task handler execution later cleanly no-ops
  const staleTaskResult = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
  });
  assert.equal(staleTaskResult.expired, false);
  assert.equal(staleTaskResult.reason, 'OFFER_NOT_ACTIVE');
});

test('10. Crash Window D: task never delivered -> due reconciler directly expires and cascades', async () => {
  await seedDriver('driver_1');
  await seedDriver('driver_2');
  await seedJob('job_1');

  const failingTaskQueue = {
    enqueueOfferTimeoutTask: async () => ({ enqueued: false, code: 'UNAVAILABLE' }),
  };
  const service = createDispatchService({ db, now, taskQueueService: failingTaskQueue });
  const dispatchResult = await service.processDispatchJob('job_1');
  assert.equal(dispatchResult.dispatched, true);

  // Advance time past 45s with task never firing
  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService: failingTaskQueue });
  const counts = await recovery.reconcileOfferTimeouts();
  assert.equal(counts.expired, 1);

  // Job cascaded to driver_2
  const job = await read(jobRef('job_1'));
  assert.equal(job.status, 'offered');
  assert.equal(job.offeredTo, 'driver_2');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'expired');
});

test('11. Crash Window E: task delivered twice -> first resolves, second no-ops', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  clock += 45000;
  const res1 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });
  assert.equal(res1.expired, true);

  const res2 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });
  assert.equal(res2.expired, false);
  assert.equal(res2.reason, 'OFFER_NOT_ACTIVE');
});

test('12. Crash Window F: reconciler expires first -> delayed task no-ops', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const recovery = createDispatchRecovery({ db, now, service });
  const dispatchResult = await service.processDispatchJob('job_1');

  clock += 46000;
  // Reconciler runs at T+46s
  await recovery.reconcileOfferTimeouts();
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'expired');

  // Delayed task arrives at T+50s
  clock += 4000;
  const taskResult = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
  });
  assert.equal(taskResult.expired, false);
  assert.equal(taskResult.reason, 'OFFER_NOT_ACTIVE');
});

test('13. Crash Window G: early task cannot expire before authoritative Timestamp', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Early task at T+20s
  clock += 20000;
  const earlyResult = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
  });

  assert.equal(earlyResult.expired, false);
  assert.equal(earlyResult.early, true);
  assert.equal(earlyResult.reason, 'OFFER_NOT_EXPIRED');

  // Documents remain offered
  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
});

test('14. customer cancellation first vs timeout race: timeout aborts with no mutations', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Customer cancel marker written
  await jobRef('job_1').update({
    cancellationRequestedAt: T.fromMillis(clock + 10000),
    cancellationResolutionState: 'pending',
  });

  clock += 45000;
  const result = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
  });

  assert.equal(result.expired, false);
  assert.equal(result.reason, 'CANCELLATION_PRECEDENCE');
  assert.equal((await read(jobRef('job_1'))).status, 'offered');
});

test('15. future accepted-state fixture vs timeout race: timeout aborts with no mutations', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Simulate future acceptance
  await jobRef('job_1').update({ status: 'accepted', dispatchState: 'assigned', assignedDriver: 'driver_1' });
  await offerRef(dispatchResult.offerId).update({ status: 'accepted' });

  clock += 45000;
  const result = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: dispatchResult.offerId,
    dispatchGeneration: 1,
  });

  assert.equal(result.expired, false);
  assert.equal(result.reason, 'OFFER_NOT_ACTIVE');
  assert.equal((await read(jobRef('job_1'))).status, 'accepted');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'accepted');
});

test('16. driver.activeOfferId mismatch fails closed with zero mutations', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt driver activeOfferId
  await driverRef('driver_1').update({ activeOfferId: 'different_offer_id' });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'DRIVER_ENGAGEMENT_MISMATCH' }
  );

  // Assert ZERO destructive mutations
  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('17. run.currentOfferId mismatch fails closed with zero mutations', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt run currentOfferId
  await runRef('job_1').update({ currentOfferId: 'different_offer_id' });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'RUN_CONFLICT' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

// ── Sol Ultra Real Emulator Corruption Probes ────────────────────────────────

test('Sol Probe 1: job.offeredTo mismatch fails closed with zero mutations', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt job.offeredTo
  await jobRef('job_1').update({ offeredTo: 'different_driver_id' });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'JOB_OFFER_MISMATCH' }
  );

  const job = await read(jobRef('job_1'));
  const offer = await read(offerRef(dispatchResult.offerId));
  const driverDoc = await read(driverRef('driver_1'));

  assert.equal(job.status, 'offered');
  assert.equal(job.offeredTo, 'different_driver_id');
  assert.equal(offer.status, 'offered');
  assert.equal(driverDoc.activeOfferId, dispatchResult.offerId);
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('Sol Probe 2: candidate outcome accepted fails closed, never overwrites or cascades', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt candidate outcome to accepted
  const runBefore = await read(runRef('job_1'));
  const updatedCandidates = runBefore.candidates.map(c => ({ ...c, outcome: 'accepted' }));
  await runRef('job_1').update({ candidates: updatedCandidates });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'CANDIDATE_OUTCOME_CONFLICT' }
  );

  const runAfter = await read(runRef('job_1'));
  assert.equal(runAfter.candidates[0].outcome, 'accepted'); // Unchanged
  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('Sol Probe 3: nested run internal generation mismatch fails closed', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt run internal generation to 2 at path 1
  await runRef('job_1').update({ generation: 2 });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'RUN_GENERATION_MISMATCH' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('Sol Probe 4: stateVersion string "1" fails closed with zero mutations (no "11" string concatenation)', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt job stateVersion to string "1"
  await jobRef('job_1').update({ stateVersion: '1' });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'JOB_STATE_VERSION_INVALID' }
  );

  const job = await read(jobRef('job_1'));
  assert.equal(job.stateVersion, '1'); // Never mutated to "11"
  assert.equal(job.status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('Sol Probe 5: contradictory cancellationResolvedAt provenance fails closed', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  // Corrupt job with cancellationResolvedAt non-null while cancellationResolutionState is 'none'
  await jobRef('job_1').update({
    cancellationRequestedAt: null,
    cancellationResolutionState: 'none',
    cancellationResolvedAt: T.fromMillis(clock + 10000),
  });

  clock += 45000;
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'CANCELLATION_PROVENANCE_CONFLICT' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await read(driverRef('driver_1'))).activeOfferId, dispatchResult.offerId);
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('Sol Probe 8, 9, 10, 11: malformed candidate index, cursor, driver, outcome fail closed', async () => {
  await seedDriver('driver_1');
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  const dispatchResult = await service.processDispatchJob('job_1');

  clock += 45000;

  // 8. Malformed candidateIndex in offer
  await offerRef(dispatchResult.offerId).update({ candidateIndex: 99 });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'CANDIDATE_INDEX_OUT_OF_BOUNDS' }
  );
  await offerRef(dispatchResult.offerId).update({ candidateIndex: 0 });

  // 9. Malformed nextCandidateIndex in run
  await runRef('job_1').update({ nextCandidateIndex: 0 });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'RUN_CURSOR_INVALID' }
  );
  await runRef('job_1').update({ nextCandidateIndex: 1 });

  // 10. Candidate driver mismatch in run
  await runRef('job_1').update({
    candidates: [{
      driverId: 'different_driver_id',
      roundIndex: 0,
      haversineDistanceKm: 3.5,
      matrixEtaSeconds: 600,
      matrixDistanceMeters: 5000,
      rankingMode: 'ola',
      outcome: 'offered',
      reasonCode: null,
    }],
  });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({
      jobId: 'job_1',
      offerId: dispatchResult.offerId,
      dispatchGeneration: 1,
    }),
    { code: 'CANDIDATE_DRIVER_MISMATCH' }
  );

  // All documents remain unchanged
  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(dispatchResult.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

// ── Starvation Repair Orchestration Test ─────────────────────────────────────

test('Starvation Repair: Stage 3 recovery progresses due offers & pending enqueues despite large Stage 2 backlog', async () => {
  // 1. Create 5 pending_offer jobs (Stage 2 backlog)
  for (let i = 1; i <= 5; i++) {
    await seedJob(`job_pending_${i}`);
  }

  // 2. Create an already-due Stage 3 offered job
  await seedDriver('driver_due_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_due_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_due_1');

  const service = createDispatchService({ db, now });
  const d1 = await service.processDispatchJob('job_due_1');
  assert.equal(d1.dispatched, true);

  // Advance time past 45s -> job_due_1 is now due
  clock += 45000;

  // 3. Create a current offered job with pending task enqueue (expires in future)
  await seedDriver('driver_active_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_active_1');
  const dActive = await service.processDispatchJob('job_active_1');
  assert.equal(dActive.dispatched, true);

  // Simulate pending enqueue state for job_active_1
  await offerRef(dActive.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  // 4. Run Stage 3 independent recovery (reconcileOfferTimeouts) with a working task queue
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const recoveryService = createDispatchService({ db, now, taskQueueService });
  const recovery = createDispatchRecovery({ db, now, service: recoveryService, taskQueueService, batchSize: 2 });

  const counts = await recovery.reconcileOfferTimeouts({ dueBatchSize: 2, enqueueBatchSize: 2 });

  // Proves Stage 3 recovery succeeded on both categories WITHOUT touching or needing to finish Stage 2 backlog!
  assert.equal(counts.expired, 1);
  assert.equal(counts.markerConverged, 1);

  // Due job cascaded to driver_due_2
  const jobDue = await read(jobRef('job_due_1'));
  assert.equal(jobDue.status, 'offered');
  assert.equal(jobDue.offeredTo, 'driver_due_2');

  // Active job offer converged to enqueued
  const offerActive = await read(offerRef(dActive.offerId));
  assert.equal(offerActive.timeoutTaskState, 'enqueued');
  assert.ok(offerActive.timeoutTaskId);

  // Stage 2 pending jobs remain untouched in pending_offer state
  const pending1 = await read(jobRef('job_pending_1'));
  assert.equal(pending1.status, 'pending_offer');
});

// ── P1 Authoritative Run / Cursor / History Coherence Emulator Regressions ───

test('P1 Emulator 1: nextCandidateIndex skips ahead (1 -> 2) fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  assert.equal(d.dispatched, true);

  clock += 45000;
  const jobBefore = await read(jobRef('job_1'));

  // Corrupt cursor: skips ahead to 2
  await runRef('job_1', 1).update({ nextCandidateIndex: 2 });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_CURSOR_INVALID' }
  );

  const jobAfter = await read(jobRef('job_1'));
  assert.equal(jobAfter.status, 'offered');
  assert.equal(jobAfter.stateVersion, jobBefore.stateVersion);
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await read(driverRef('driver_1'))).activeOfferId, d.offerId);
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 2: nextCandidateIndex behind legal position fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  // Corrupt cursor: behind legal position 1 (set to 0)
  await runRef('job_1', 1).update({ nextCandidateIndex: 0 });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_CURSOR_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 3: future driver inserted into attemptedDriverIds fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  // Future driver (driver_2) inserted into attemptedDriverIds prematurely
  await runRef('job_1', 1).update({ attemptedDriverIds: ['driver_1', 'driver_2'] });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_ATTEMPTED_DRIVERS_MISMATCH' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 4: duplicate attemptedDriverIds fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  await runRef('job_1', 1).update({ attemptedDriverIds: ['driver_1', 'driver_1'] });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 5: duplicate candidate driver identity fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  const run = await read(runRef('job_1', 1));
  run.candidates[1].driverId = 'driver_1'; // Duplicate candidate driver ID
  await runRef('job_1', 1).set(run);

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 6: second candidate simultaneously outcome = offered fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  const run = await read(runRef('job_1', 1));
  run.candidates[1].outcome = 'offered'; // Second candidate simultaneously offered
  await runRef('job_1', 1).set(run);

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 7: future candidate has resolved outcome inconsistent with cursor fails closed', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  const run = await read(runRef('job_1', 1));
  run.candidates[1].outcome = 'expired'; // Future candidate resolved ahead of time
  await runRef('job_1', 1).set(run);

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 8: current offered driver missing from attempted history fails closed', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  await runRef('job_1', 1).update({ attemptedDriverIds: [] });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_ATTEMPTED_DRIVERS_MISMATCH' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 9: current offered driver appears multiple times in history fails closed', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  await runRef('job_1', 1).update({ attemptedDriverIds: ['driver_1', 'driver_1'] });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_INVALID' }
  );

  assert.equal((await read(jobRef('job_1'))).status, 'offered');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

test('P1 Emulator 10: combined cursor + candidate contradiction never produces false no_driver_found or refund', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  // Simulate previously observed Sol Ultra bug: nextCandidateIndex set to 2, attemptedDriverIds has [d1, d2], candidates[1] offered
  const run = await read(runRef('job_1', 1));
  run.nextCandidateIndex = 2;
  run.attemptedDriverIds = ['driver_1', 'driver_2'];
  run.candidates[1].outcome = 'offered';
  await runRef('job_1', 1).set(run);

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'RUN_CURSOR_INVALID' }
  );

  // Authoritative before == after: zero writes, no cancelled_system, no no_driver_found, no refund
  const job = await read(jobRef('job_1'));
  assert.equal(job.status, 'offered');
  assert.equal(job.offeredTo, 'driver_1');
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await read(driverRef('driver_1'))).activeOfferId, d.offerId);
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

// ── Legitimate Later-Candidate Normal History Regressions ─────────────────────

test('Normal History 1: second candidate current offer after first timed out expires cleanly and cascades', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedDriver('driver_3', { location: new GeoPoint(18.535, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });

  // 1. First offer to driver_1
  const d1 = await service.processDispatchJob('job_1');
  assert.equal(d1.dispatched, true);
  assert.equal((await read(jobRef('job_1'))).offeredTo, 'driver_1');

  // Advance time past 45s and expire first offer with cascade
  clock += 45000;
  const res1 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: d1.offerId,
    dispatchGeneration: 1,
    triggerCascade: true,
  });
  assert.equal(res1.expired, true);

  // Job cascaded to driver_2
  const jobAfterCascade1 = await read(jobRef('job_1'));
  assert.equal(jobAfterCascade1.status, 'offered');
  assert.equal(jobAfterCascade1.offeredTo, 'driver_2');
  const offerId2 = jobAfterCascade1.currentOfferId;

  // Run has candidate 0 = expired, candidate 1 = offered, candidate 2 = pending
  const runAfterCascade1 = await read(runRef('job_1', 1));
  assert.equal(runAfterCascade1.nextCandidateIndex, 2);
  assert.equal(runAfterCascade1.candidates[0].outcome, 'expired');
  assert.equal(runAfterCascade1.candidates[1].outcome, 'offered');
  assert.equal(runAfterCascade1.candidates[2].outcome, 'pending');
  assert.deepEqual(runAfterCascade1.attemptedDriverIds, ['driver_1', 'driver_2']);

  // 2. Second offer to driver_2 expires cleanly and cascades to driver_3
  clock += 45000;
  const res2 = await timeoutManager.expireOfferTimeout({
    jobId: 'job_1',
    offerId: offerId2,
    dispatchGeneration: 1,
    triggerCascade: true,
  });
  assert.equal(res2.expired, true);

  const jobAfterCascade2 = await read(jobRef('job_1'));
  assert.equal(jobAfterCascade2.status, 'offered');
  assert.equal(jobAfterCascade2.offeredTo, 'driver_3');
});

// ── LOW P3 Real Emulator Regression ──────────────────────────────────────────

test('LOW P3 Emulator: job.stateVersion at MAX_SAFE_INTEGER fails closed with zero mutations', async () => {
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.530, 73.86) });
  await seedJob('job_1');

  const service = createDispatchService({ db, now });
  const d = await service.processDispatchJob('job_1');
  clock += 45000;

  await jobRef('job_1').update({ stateVersion: Number.MAX_SAFE_INTEGER });

  const timeoutManager = createOfferTimeoutManager({ db, now, dispatchService: service });
  await assert.rejects(
    () => timeoutManager.expireOfferTimeout({ jobId: 'job_1', offerId: d.offerId, dispatchGeneration: 1 }),
    { code: 'JOB_STATE_VERSION_INVALID' }
  );

  const job = await read(jobRef('job_1'));
  assert.equal(job.status, 'offered');
  assert.equal(job.stateVersion, Number.MAX_SAFE_INTEGER);
  assert.equal((await read(offerRef(d.offerId))).status, 'offered');
  assert.equal((await read(driverRef('driver_1'))).activeOfferId, d.offerId);
  assert.equal((await db.doc('refund_requests/job_1').get()).exists, false);
});

// ── P2 Finite Invocation Budget Emulator Tests ────────────────────────────────

test('P2 Emulator: total due and enqueue work never exceeds explicit invocation budgets', async () => {
  // 1. Seed 4 due offered jobs
  const service = createDispatchService({ db, now });
  for (let i = 1; i <= 2; i++) {
    await seedDriver(`driver_due_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_due_${i}`);
    await service.processDispatchJob(`job_due_${i}`);
  }

  // Advance time past 45s -> all 4 are now due
  clock += 45000;

  // 2. Seed 4 active offered jobs needing task enqueue
  for (let i = 1; i <= 4; i++) {
    await seedDriver(`driver_enq_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_enq_${i}`);
    const res = await service.processDispatchJob(`job_enq_${i}`);
    await offerRef(res.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });
  }

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 2 });

  // Run invocation with explicit budgets of 2 each
  const counts = await recovery.reconcileOfferTimeouts({
    maxDueOffersPerInvocation: 2,
    maxPendingEnqueuesPerInvocation: 2,
    dueBatchSize: 1,
    enqueueBatchSize: 1,
  });

  // Exactly 2 due offers processed and exactly 2 pending enqueues processed
  assert.equal(counts.discoveredDue, 2);
  assert.equal(counts.expired, 2);
  assert.equal(counts.discoveredPending, 2);
  assert.equal(counts.markerConverged, 2);
});

// ── Recovery Checkpoint Contract Tests (Real Firestore Emulator) ───

test('Checkpoint Contract 1: bootstrap missing checkpoint document', async () => {
  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await ref.delete();

  const data = await getOrBootstrapCheckpoint(db, ref, T, clock);
  assert.equal(data.version, 1);
  assert.equal(data.dueOfferSweep.sweepEpoch, 1);
  assert.equal(data.dueOfferSweep.cursor.offerExpiresAt, null);
  assert.equal(data.dueOfferSweep.cursor.jobId, null);
  assert.equal(data.dueOfferSweep.upperBound.offerExpiresAt, null);
  assert.equal(data.dueOfferSweep.upperBound.jobId, null);
  assert.equal(data.pendingEnqueueSweep.sweepEpoch, 1);
  assert.equal(data.pendingEnqueueSweep.cursor.expiresAt, null);
  assert.equal(data.pendingEnqueueSweep.cursor.offerId, null);
  assert.equal(data.pendingEnqueueSweep.upperBound.expiresAt, null);
  assert.equal(data.pendingEnqueueSweep.upperBound.offerId, null);
  assert.ok(data.updatedAt);

  assert.doesNotThrow(() => validateRecoveryCheckpoint(data));
});

test('Checkpoint Contract 2: concurrent bootstrap converges to one canonical state', async () => {
  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await ref.delete();

  const results = await Promise.all([
    getOrBootstrapCheckpoint(db, ref, T, clock),
    getOrBootstrapCheckpoint(db, ref, T, clock),
    getOrBootstrapCheckpoint(db, ref, T, clock),
    getOrBootstrapCheckpoint(db, ref, T, clock),
    getOrBootstrapCheckpoint(db, ref, T, clock),
  ]);

  for (const res of results) {
    assert.equal(res.version, 1);
    assert.equal(res.dueOfferSweep.sweepEpoch, 1);
    assert.equal(res.pendingEnqueueSweep.sweepEpoch, 1);
  }

  const persisted = (await ref.get()).data();
  assert.equal(persisted.version, 1);
  assert.equal(persisted.dueOfferSweep.sweepEpoch, 1);
});

test('Checkpoint Contract 3: high-water tuple uses timestamp + document ID', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');

  clock += 10000;
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_2');
  await service.processDispatchJob('job_2');

  // Both are due
  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 1 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const persisted = (await ref.get()).data();
  assert.equal(persisted.dueOfferSweep.upperBound.jobId, 'job_2');
  assert.ok(persisted.dueOfferSweep.upperBound.offerExpiresAt);
});

test('Checkpoint Contract 4: equal timestamps choose deterministic highest ID', async () => {
  const service = createDispatchService({ db, now });
  const fixedExpiresAt = T.fromMillis(clock + 45000);

  for (const id of ['job_alpha', 'job_gamma', 'job_beta']) {
    await seedDriver(`driver_${id}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(id, { status: 'offered', offerExpiresAt: fixedExpiresAt, currentOfferId: `offer_${id}`, dispatchGeneration: 1 });
  }

  clock += 50000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 1 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const persisted = (await ref.get()).data();
  assert.equal(persisted.dueOfferSweep.upperBound.jobId, 'job_gamma');
});

test('Checkpoint Contract 5: continuous arrivals do not extend current sweep', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 1 });

  // Invocation 1: captures upper bound (job_2) and processes job_1
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  let checkpoint = (await ref.get()).data();
  assert.equal(checkpoint.dueOfferSweep.sweepEpoch, 1);
  assert.equal(checkpoint.dueOfferSweep.upperBound.jobId, 'job_2');
  assert.equal(checkpoint.dueOfferSweep.cursor.jobId, 'job_1');

  // Continuous arrivals: seed job 3, 4, 5
  for (let i = 3; i <= 5; i++) {
    await seedDriver(`driver_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_${i}`);
    await service.processDispatchJob(`job_${i}`);
  }
  clock += 45000;

  // Invocation 2: budget 10. Must terminate strictly at job_2, ignoring job_3..5
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 10 });

  checkpoint = (await ref.get()).data();
  assert.equal(checkpoint.dueOfferSweep.sweepEpoch, 2);
  assert.equal(checkpoint.dueOfferSweep.cursor.jobId, null);
  assert.equal(checkpoint.dueOfferSweep.upperBound.jobId, null);

  // Job 3 was not touched in sweep 1
  const job3 = await read(jobRef('job_3'));
  assert.equal(job3.status, 'offered');

  // Invocation 3: sweep 2 begins, now captures new upper bound and processes job_3..5
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 10 });

  const job3After = await read(jobRef('job_3'));
  assert.ok(job3After.stateVersion > 1);
});

test('Checkpoint Contract 6: records beyond upperBound wait until next sweep', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 1 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const cp = (await ref.get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, 2);
});

test('Checkpoint Contract 7: hard due scanned-doc budget', async () => {
  const service = createDispatchService({ db, now });
  for (let i = 1; i <= 5; i++) {
    await seedDriver(`driver_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_${i}`);
    await service.processDispatchJob(`job_${i}`);
  }
  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 2 });
  const counts = await recovery.reconcileOfferTimeouts({
    maxDueScannedPerInvocation: 2,
    maxPendingScannedPerInvocation: 0,
    dueBatchSize: 1,
  });

  assert.equal(counts.dueScanned, 2);
  assert.equal(counts.expired, 2);

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.ok(cp.dueOfferSweep.cursor.jobId);
  assert.equal(cp.dueOfferSweep.sweepEpoch, 1);
});

test('Checkpoint Contract 8: hard pending scanned-doc budget', async () => {
  const service = createDispatchService({ db, now });
  for (let i = 1; i <= 5; i++) {
    await seedDriver(`driver_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_${i}`);
    const res = await service.processDispatchJob(`job_${i}`);
    await offerRef(res.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });
  }

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 2 });

  const counts = await recovery.reconcileOfferTimeouts({
    maxPendingScannedPerInvocation: 2,
    enqueueBatchSize: 1,
  });

  assert.equal(counts.pendingScanned, 2);
  assert.equal(counts.markerConverged, 2);

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.ok(cp.pendingEnqueueSweep.cursor.offerId);
  assert.equal(cp.pendingEnqueueSweep.sweepEpoch, 1);
});

test('Checkpoint Contract 9: already-enqueued offers consume scan budget', async () => {
  const service = createDispatchService({ db, now });
  const offerIds = [];
  for (let i = 1; i <= 4; i++) {
    clock += 1000;
    await seedDriver(`driver_${i}`, { location: new GeoPoint(18.525, 73.86) });
    await seedJob(`job_${i}`);
    const res = await service.processDispatchJob(`job_${i}`);
    offerIds.push(res.offerId);
  }

  await offerRef(offerIds[0]).update({ timeoutTaskState: 'enqueued', timeoutTaskId: 'task_0' });
  await offerRef(offerIds[1]).update({ timeoutTaskState: 'enqueued', timeoutTaskId: 'task_1' });
  await offerRef(offerIds[2]).update({ timeoutTaskState: 'enqueued', timeoutTaskId: 'task_2' });
  await offerRef(offerIds[3]).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 2 });

  const c1 = await recovery.reconcileOfferTimeouts({
    maxPendingScannedPerInvocation: 2,
    enqueueBatchSize: 1,
  });

  assert.equal(c1.pendingScanned, 2);
  assert.equal(c1.markerConverged, 0);

  const offer3 = await read(offerRef(offerIds[3]));
  assert.equal(offer3.timeoutTaskState, 'pending');

  const c2 = await recovery.reconcileOfferTimeouts({
    maxPendingScannedPerInvocation: 2,
    enqueueBatchSize: 1,
  });
  assert.equal(c2.pendingScanned, 2);
  assert.equal(c2.markerConverged, 1);

  const offer3After = await read(offerRef(offerIds[3]));
  assert.equal(offer3After.timeoutTaskState, 'enqueued');
});

test('Checkpoint Contract 10: corrupt prefix is passed without domain mutation', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_corrupt', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_healthy', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_corrupt');
  await seedJob('job_healthy');

  await service.processDispatchJob('job_corrupt');
  await service.processDispatchJob('job_healthy');

  await runRef('job_corrupt').update({ nextCandidateIndex: 99 });

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 }); },
    /RECOVERY_INCOMPLETE/
  );

  const jc = await read(jobRef('job_corrupt'));
  assert.equal(jc.status, 'offered');
  assert.equal(jc.stateVersion, 1);

  const jh = await read(jobRef('job_healthy'));
  assert.ok(jh.stateVersion > 1);

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, 2);
});

test('Checkpoint Contract 11: healthy record behind corrupt prefix progresses', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_c1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_h1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_c1');
  await seedJob('job_h1');

  await service.processDispatchJob('job_c1');
  await service.processDispatchJob('job_h1');

  await runRef('job_c1').update({ 'candidates.0.driverId': 'mismatched_driver' });

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 2 });
  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 2 }); },
    /RECOVERY_INCOMPLETE/
  );

  const jh = await read(jobRef('job_h1'));
  assert.ok(jh.stateVersion > 1);
});

test('Checkpoint Contract 12: transient failure in sweep N is revisited in N+1', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_flaky', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_stable', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_flaky');
  await seedJob('job_stable');

  await service.processDispatchJob('job_flaky');
  await service.processDispatchJob('job_stable');

  clock += 45000;

  let shouldFailFlaky = true;
  const realTimeoutMgr = createOfferTimeoutManager({ db, now, dispatchService: service });
  const flakyTimeoutMgr = {
    expireOfferTimeout: async (params) => {
      if (params.jobId === 'job_flaky' && shouldFailFlaky) {
        throw new Error('TRANSIENT_NETWORK_FAILURE');
      }
      return realTimeoutMgr.expireOfferTimeout(params);
    },
    convergeTaskMarker: (p) => realTimeoutMgr.convergeTaskMarker(p),
  };

  const recovery = createDispatchRecovery({
    db, now, service, timeoutManager: flakyTimeoutMgr, batchSize: 5,
  });

  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 }); },
    /RECOVERY_INCOMPLETE/
  );

  const jStable = await read(jobRef('job_stable'));
  assert.ok(jStable.stateVersion > 1);

  const jFlaky1 = await read(jobRef('job_flaky'));
  assert.equal(jFlaky1.status, 'offered');
  assert.equal(jFlaky1.stateVersion, 1);

  const cp1 = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cp1.dueOfferSweep.sweepEpoch, 2);

  shouldFailFlaky = false;

  const c2 = await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });
  assert.equal(c2.expired, 1);

  const jFlaky2 = await read(jobRef('job_flaky'));
  assert.ok(jFlaky2.stateVersion > 1);
});

test('Checkpoint Contract 13: crash before checkpoint commit causes safe replay', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  const d1 = await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');

  clock += 45000;

  // Expire job_1 directly to simulate crash after domain transaction but before checkpoint write
  const tm = createOfferTimeoutManager({ db, now, dispatchService: service });
  await tm.expireOfferTimeout({
    jobId: 'job_1',
    offerId: d1.offerId,
    dispatchGeneration: 1,
    triggerCascade: false,
  });

  // Next worker starts with fresh/uncommitted checkpoint
  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  const counts = await recovery.reconcileOfferTimeouts({
    maxDueScannedPerInvocation: 5,
    maxPendingScannedPerInvocation: 0,
  });

  assert.equal(counts.expired, 1);
  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, 2);
});

test('Checkpoint Contract 14: overlapping workers cannot regress cursor (real paused production workers)', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');
  clock += 45000;

  let pauseWorker1;
  const worker1AtBarrier = new Promise(res => { pauseWorker1 = res; });
  let resumeWorker1;
  const worker1Release = new Promise(res => { resumeWorker1 = res; });

  const realTm = createOfferTimeoutManager({ db, now, dispatchService: service });
  const hookedTm1 = {
    expireOfferTimeout: async (params) => {
      const res = await realTm.expireOfferTimeout(params);
      if (params.jobId === 'job_1') {
        pauseWorker1();
        await worker1Release;
      }
      return res;
    },
    convergeTaskMarker: (p) => realTm.convergeTaskMarker(p),
  };

  const recovery1 = createDispatchRecovery({ db, now, service, timeoutManager: hookedTm1, batchSize: 1 });
  const recovery2 = createDispatchRecovery({ db, now, service, timeoutManager: realTm, batchSize: 5 });

  // Worker 1 starts, processes job_1, and pauses before checkpoint commit
  const worker1Promise = recovery1.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });
  await worker1AtBarrier;

  // Meanwhile Worker 2 runs to completion across all jobs
  await recovery2.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const cpAfterWorker2 = (await ref.get()).data();
  assert.equal(cpAfterWorker2.dueOfferSweep.sweepEpoch, 2);
  assert.equal(cpAfterWorker2.dueOfferSweep.cursor.jobId, null);

  // Resume Worker 1
  resumeWorker1();
  await worker1Promise;

  // Worker 1 was fenced out by production CAS; cursor did NOT regress
  const persisted = (await ref.get()).data();
  assert.equal(persisted.dueOfferSweep.sweepEpoch, 2);
  assert.equal(persisted.dueOfferSweep.cursor.jobId, null);
});

test('Checkpoint Contract 15: old epoch cannot modify new epoch (real paused production workers)', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');
  clock += 45000;

  let pauseWorker1;
  const worker1AtBarrier = new Promise(res => { pauseWorker1 = res; });
  let resumeWorker1;
  const worker1Release = new Promise(res => { resumeWorker1 = res; });

  const realTm = createOfferTimeoutManager({ db, now, dispatchService: service });
  const hookedTm1 = {
    expireOfferTimeout: async (params) => {
      const res = await realTm.expireOfferTimeout(params);
      pauseWorker1();
      await worker1Release;
      return res;
    },
    convergeTaskMarker: (p) => realTm.convergeTaskMarker(p),
  };

  const recovery1 = createDispatchRecovery({ db, now, service, timeoutManager: hookedTm1, batchSize: 1 });
  const recovery2 = createDispatchRecovery({ db, now, service, timeoutManager: realTm, batchSize: 5 });

  const worker1Promise = recovery1.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });
  await worker1AtBarrier;

  await recovery2.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });
  const cpMid = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cpMid.dueOfferSweep.sweepEpoch, 2);

  resumeWorker1();
  await worker1Promise;

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const persisted = (await ref.get()).data();
  assert.equal(persisted.dueOfferSweep.sweepEpoch, 2);
  assert.equal(persisted.dueOfferSweep.cursor.jobId, null);
});

test('Checkpoint Contract 16: worker with different upperBound cannot modify checkpoint (real paused production workers)', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');
  clock += 45000;

  let pauseWorker1;
  const worker1AtBarrier = new Promise(res => { pauseWorker1 = res; });
  let resumeWorker1;
  const worker1Release = new Promise(res => { resumeWorker1 = res; });

  const realTm = createOfferTimeoutManager({ db, now, dispatchService: service });
  const hookedTm1 = {
    expireOfferTimeout: async (params) => {
      const res = await realTm.expireOfferTimeout(params);
      pauseWorker1();
      await worker1Release;
      return res;
    },
    convergeTaskMarker: (p) => realTm.convergeTaskMarker(p),
  };

  const recovery1 = createDispatchRecovery({ db, now, service, timeoutManager: hookedTm1, batchSize: 1 });

  const worker1Promise = recovery1.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });
  await worker1AtBarrier;

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await ref.update({
    'dueOfferSweep.upperBound': { offerExpiresAt: T.fromMillis(clock + 10000), jobId: 'job_other_ub' },
  });

  resumeWorker1();
  await worker1Promise;

  const persisted = (await ref.get()).data();
  assert.equal(persisted.dueOfferSweep.upperBound.jobId, 'job_other_ub');
  assert.equal(persisted.dueOfferSweep.cursor.jobId, null);
});

test('Checkpoint Contract 17: upperBound remains immutable during mid-sweep advancement', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await seedJob('job_2');
  await service.processDispatchJob('job_1');
  await service.processDispatchJob('job_2');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 1 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 1 });

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const cp = (await ref.get()).data();
  assert.equal(cp.dueOfferSweep.cursor.jobId, 'job_1');
  assert.equal(cp.dueOfferSweep.upperBound.jobId, 'job_2');
});

test('Checkpoint Contract 18: concurrent sweep completion increments epoch once using production workers', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');

  clock += 45000;

  const recovery1 = createDispatchRecovery({ db, now, service, batchSize: 5 });
  const recovery2 = createDispatchRecovery({ db, now, service, batchSize: 5 });

  await Promise.all([
    recovery1.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 }),
    recovery2.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 }),
  ]);

  const persisted = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(persisted.dueOfferSweep.sweepEpoch, 2);
  assert.equal(persisted.dueOfferSweep.cursor.offerExpiresAt, null);
  assert.equal(persisted.dueOfferSweep.upperBound.offerExpiresAt, null);
});

test('Checkpoint Contract 19: sweep wrap resets cursor + upperBound', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, 2);
  assert.equal(cp.dueOfferSweep.cursor.offerExpiresAt, null);
  assert.equal(cp.dueOfferSweep.cursor.jobId, null);
  assert.equal(cp.dueOfferSweep.upperBound.offerExpiresAt, null);
  assert.equal(cp.dueOfferSweep.upperBound.jobId, null);
});

test('Checkpoint Contract 20: sweepEpoch MAX_SAFE_INTEGER fails closed with zero checkpoint mutations', async () => {
  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await getOrBootstrapCheckpoint(db, ref, T, clock);
  await ref.update({ 'dueOfferSweep.sweepEpoch': Number.MAX_SAFE_INTEGER });

  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');
  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 2 });
  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 2 }); },
    /SWEEP_EPOCH_OVERFLOW/
  );

  // Assert ZERO mutations on checkpoint
  const cp = (await ref.get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal(cp.dueOfferSweep.cursor.offerExpiresAt, null);
  assert.equal(cp.dueOfferSweep.cursor.jobId, null);
  assert.equal(cp.dueOfferSweep.upperBound.offerExpiresAt, null);
  assert.equal(cp.dueOfferSweep.upperBound.jobId, null);

  // Assert ZERO mutations on job
  const j = await read(jobRef('job_1'));
  assert.equal(j.status, 'offered');
  assert.equal(j.stateVersion, 1);
});

test('Checkpoint Contract 21: Category A and B checkpoints progress independently', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_1');
  await service.processDispatchJob('job_1');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, 2);
  assert.equal(cp.pendingEnqueueSweep.sweepEpoch, 1);
  assert.equal(cp.pendingEnqueueSweep.upperBound.offerId, null);
});

test('Checkpoint Contract 22: Stage 2 pending_offer backlog does not affect Stage 3 recovery', async () => {
  const service = createDispatchService({ db, now });

  for (let i = 1; i <= 20; i++) {
    await seedJob(`job_pending_${i}`);
  }

  await seedDriver('driver_due_1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_due_1');
  await service.processDispatchJob('job_due_1');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 2 });
  const counts = await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 2 });

  assert.equal(counts.expired, 1);
  const jDue = await read(jobRef('job_due_1'));
  assert.ok(jDue.stateVersion > 1);

  const jPending = await read(jobRef('job_pending_1'));
  assert.equal(jPending.status, 'pending_offer');
});

// =============================================================================
// AUDIT DEFECT REPAIR REGRESSIONS (BLOCKERS 1 TO 5)
// =============================================================================

test('Audit Regression 1: DESC high-water index contract A (jobs offerExpiresAt DESC)', async () => {
  await seedJob('job_desc_a');
  await jobRef('job_desc_a').update({
    status: 'offered',
    offerExpiresAt: T.fromMillis(clock - 1000),
  });

  const snap = await db.collection('jobs')
    .where('status', '==', 'offered')
    .where('offerExpiresAt', '<=', T.fromMillis(clock))
    .orderBy('offerExpiresAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(1)
    .get();

  assert.equal(snap.empty, false);
  assert.equal(snap.docs[0].id, 'job_desc_a');
});

test('Audit Regression 2: DESC high-water index contract B (job_offers expiresAt DESC)', async () => {
  await offerRef('offer_desc_b').set({
    status: 'offered',
    expiresAt: T.fromMillis(clock + 10000),
    jobId: 'job_desc_b',
    driverId: 'driver_1',
    dispatchGeneration: 1,
    candidateIndex: 0,
    timeoutTaskState: 'pending',
    timeoutTaskId: null,
    createdAt: T.fromMillis(clock),
  });

  const snap = await db.collection('job_offers')
    .where('status', '==', 'offered')
    .orderBy('expiresAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc')
    .limit(1)
    .get();

  assert.equal(snap.empty, false);
  assert.equal(snap.docs[0].id, 'offer_desc_b');
});

test('Audit Regression 3: Timestamp(S, 0) vs Timestamp(S, 1) exact sub-millisecond precision', () => {
  const ts0 = new T(100, 0);
  const ts1 = new T(100, 1);
  assert.equal(compareTimestamp(ts0, ts1), -1);
  assert.equal(compareTimestamp(ts1, ts0), 1);
  assert.equal(compareTimestamp(ts0, ts0), 0);
  assert.equal(compareTimestamp(ts1, ts1), 0);
});

test('Audit Regression 4: Timestamp(S, 0) vs Timestamp(S, 1000) exact sub-millisecond precision', () => {
  const ts0 = new T(100, 0);
  const ts1000 = new T(100, 1000);
  assert.equal(compareTimestamp(ts0, ts1000), -1);
  assert.equal(compareTimestamp(ts1000, ts0), 1);

  const t1 = { offerExpiresAt: ts0, jobId: 'j1' };
  const t2 = { offerExpiresAt: ts1000, jobId: 'j1' };
  assert.equal(compareTuples(t1, t2, 'offerExpiresAt', 'jobId'), -1);
  assert.equal(compareTuples(t2, t1, 'offerExpiresAt', 'jobId'), 1);
});

test('Audit Regression 5: same timestamp + document-ID tie break', () => {
  const ts = new T(100, 500);
  const tA = { offerExpiresAt: ts, jobId: 'job_a' };
  const tB = { offerExpiresAt: ts, jobId: 'job_b' };
  const tA2 = { offerExpiresAt: ts, jobId: 'job_a' };

  assert.equal(compareTuples(tA, tB, 'offerExpiresAt', 'jobId'), -1);
  assert.equal(compareTuples(tB, tA, 'offerExpiresAt', 'jobId'), 1);
  assert.equal(compareTuples(tA, tA2, 'offerExpiresAt', 'jobId'), 0);
});

test('Audit Regression 6: changed upperBound differing only by nanoseconds fences stale worker', async () => {
  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await getOrBootstrapCheckpoint(db, ref, T, clock);

  // Use 1000 nanoseconds (survives emulator microsecond serialization while having identical millisecond value to 0)
  const ubPersisted = { offerExpiresAt: new T(100, 1000), jobId: 'job_1' };
  await ref.update({ 'dueOfferSweep.upperBound': ubPersisted });

  const staleWorkerObservedUB = { offerExpiresAt: new T(100, 0), jobId: 'job_1' };
  const res = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    validateRecoveryCheckpoint(cur, T);
    if (compareTuples(cur.dueOfferSweep.upperBound, staleWorkerObservedUB, 'offerExpiresAt', 'jobId') !== 0) {
      return { updated: false, reason: 'FENCED_STALE' };
    }
    tx.update(ref, { 'dueOfferSweep.cursor.jobId': 'should_not_happen' });
    return { updated: true };
  });

  assert.equal(res.updated, false);
  assert.equal(res.reason, 'FENCED_STALE');
});

test('Audit Regression 7: malformed pending expiresAt Number before healthy Timestamp record', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_7', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_healthy_7');
  const res7 = await service.processDispatchJob('job_healthy_7');
  await offerRef(res7.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  await offerRef('off_num_zero').set({
    status: 'offered',
    expiresAt: 0,
    jobId: 'job_0',
    driverId: 'd_0',
    dispatchGeneration: 1,
    candidateIndex: 0,
    timeoutTaskState: 'pending',
    timeoutTaskId: null,
    createdAt: T.fromMillis(clock),
  });

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const offZero = await read(offerRef('off_num_zero'));
  assert.equal(offZero.status, 'offered');
  assert.equal(offZero.expiresAt, 0);
  assert.equal(offZero.timeoutTaskState, 'pending');

  const offH = await read(offerRef(res7.offerId));
  assert.equal(offH.timeoutTaskState, 'enqueued');

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);
  assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, 'off_num_zero');
});

test('Audit Regression 8: malformed pending expiresAt String before healthy Timestamp record', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_8', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_healthy_8');
  const res8 = await service.processDispatchJob('job_healthy_8');
  await offerRef(res8.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  await offerRef('off_str_bad').set({
    status: 'offered',
    expiresAt: 'bad',
    jobId: 'job_bad',
    driverId: 'd_bad',
    dispatchGeneration: 1,
    candidateIndex: 0,
    timeoutTaskState: 'pending',
    timeoutTaskId: null,
    createdAt: T.fromMillis(clock),
  });

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  const offBad = await read(offerRef('off_str_bad'));
  assert.equal(offBad.status, 'offered');
  assert.equal(offBad.expiresAt, 'bad');

  const offH = await read(offerRef(res8.offerId));
  assert.equal(offH.timeoutTaskState, 'enqueued');
});

test('Audit Regression 9: malformed due offerExpiresAt Number before healthy Timestamp record', async () => {
  await jobRef('job_num_zero').set({
    status: 'offered',
    offerExpiresAt: 0,
    stateVersion: 1,
    currentOfferId: 'off_0',
    dispatchGeneration: 1,
  });

  await seedDriver('driver_h9', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_healthy_9');
  const service = createDispatchService({ db, now });
  await service.processDispatchJob('job_healthy_9');

  clock += 45000;

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 10 });

  const jZero = await read(jobRef('job_num_zero'));
  assert.equal(jZero.status, 'offered');
  assert.equal(jZero.offerExpiresAt, 0);

  const jH9 = await read(jobRef('job_healthy_9'));
  assert.ok(jH9.stateVersion > 1);

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);
  assert.notEqual(cp.dueOfferSweep.cursor.jobId, 'job_num_zero');
});

test('Audit Regression 10, 11, 12: malformed candidates never persisted as upperBound or cursor; healthy work progresses', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_10', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_valid_10');
  const res10 = await service.processDispatchJob('job_valid_10');
  await offerRef(res10.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  await offerRef('off_corrupt_str').set({
    status: 'offered',
    expiresAt: 'corrupt_string',
    timeoutTaskState: 'pending',
  });
  await offerRef('off_corrupt_num').set({
    status: 'offered',
    expiresAt: 0,
    timeoutTaskState: 'pending',
  });

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  if (cp.pendingEnqueueSweep.upperBound.expiresAt !== null) {
    assert.ok(isAuthoritativeTimestamp(cp.pendingEnqueueSweep.upperBound.expiresAt, T));
    assert.equal(isLegalDocumentId(cp.pendingEnqueueSweep.upperBound.offerId), true);
    assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, 'off_corrupt_str');
    assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, 'off_corrupt_num');
  }
  if (cp.pendingEnqueueSweep.cursor.expiresAt !== null) {
    assert.ok(isAuthoritativeTimestamp(cp.pendingEnqueueSweep.cursor.expiresAt, T));
    assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, 'off_corrupt_str');
    assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, 'off_corrupt_num');
  }

  const validOff = await read(offerRef(res10.offerId));
  assert.equal(validOff.timeoutTaskState, 'enqueued');
});

test('Audit Regression 13: extra root checkpoint field -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: null, jobId: null }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint({ ...base, extraRoot: 123 }, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 14: extra sweep field -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: null, jobId: null }, upperBound: { offerExpiresAt: null, jobId: null }, extraSweep: true },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 15: extra cursor field -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: null, jobId: null, extraCursor: 'bad' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 16: extra upperBound field -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: null, jobId: null }, upperBound: { offerExpiresAt: null, jobId: null, extraUB: 99 } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 17: cursor ID containing "/" -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: new T(100, 0), jobId: 'jobs/job_1' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 18: invalid empty/noncanonical ID -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: new T(100, 0), jobId: '' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
  assert.equal(isLegalDocumentId(''), false);
  assert.equal(isLegalDocumentId('.'), false);
  assert.equal(isLegalDocumentId('..'), false);
  assert.equal(isLegalDocumentId('__proto__'), false);
  assert.equal(isLegalDocumentId('has/slash'), false);
});

test('Audit Regression 19: Date timestamp -> CHECKPOINT_INVALID', () => {
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: new Date(), jobId: 'job_1' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
  assert.equal(isAuthoritativeTimestamp(new Date(), T), false);
});

test('Audit Regression 20: duck object with toMillis -> CHECKPOINT_INVALID', () => {
  const duck = { toMillis: () => 12345 };
  const base = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: duck, jobId: 'job_1' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(base, T), { code: 'CHECKPOINT_INVALID' });
  assert.equal(isAuthoritativeTimestamp(duck, T), false);
});

test('Audit Regression 21: partial null tuple -> CHECKPOINT_INVALID', () => {
  const partial1 = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: new T(100, 0), jobId: null }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(partial1, T), { code: 'CHECKPOINT_INVALID' });

  const partial2 = {
    version: 1,
    dueOfferSweep: { sweepEpoch: 1, cursor: { offerExpiresAt: null, jobId: 'job_1' }, upperBound: { offerExpiresAt: null, jobId: null } },
    pendingEnqueueSweep: { sweepEpoch: 1, cursor: { expiresAt: null, offerId: null }, upperBound: { expiresAt: null, offerId: null } },
    updatedAt: new T(100, 0),
  };
  assert.throws(() => validateRecoveryCheckpoint(partial2, T), { code: 'CHECKPOINT_INVALID' });
});

test('Audit Regression 22, 23: epoch MAX_SAFE_INTEGER - 1 completion writes MAX_SAFE_INTEGER and reload succeeds', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_m1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_m1');
  await service.processDispatchJob('job_m1');

  clock += 45000;

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await getOrBootstrapCheckpoint(db, ref, T, clock);
  await ref.update({ 'dueOfferSweep.sweepEpoch': Number.MAX_SAFE_INTEGER - 1 });

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 });

  const cp = (await ref.get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, Number.MAX_SAFE_INTEGER);

  assert.doesNotThrow(() => validateRecoveryCheckpoint(cp, T));
  const reloaded = await getOrBootstrapCheckpoint(db, ref, T, clock);
  assert.equal(reloaded.dueOfferSweep.sweepEpoch, Number.MAX_SAFE_INTEGER);
});

test('Audit Regression 24: epoch MAX_SAFE_INTEGER cannot increment and fails closed with zero checkpoint mutations', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_m2', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_m2');
  await service.processDispatchJob('job_m2');

  clock += 45000;

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  await getOrBootstrapCheckpoint(db, ref, T, clock);
  await ref.update({ 'dueOfferSweep.sweepEpoch': Number.MAX_SAFE_INTEGER });

  const recovery = createDispatchRecovery({ db, now, service, batchSize: 5 });
  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 5 }); },
    /SWEEP_EPOCH_OVERFLOW/
  );

  const cp = (await ref.get()).data();
  assert.equal(cp.dueOfferSweep.sweepEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal(cp.dueOfferSweep.upperBound.offerExpiresAt, null);
  assert.equal(cp.dueOfferSweep.cursor.offerExpiresAt, null);
});

// =============================================================================
// ADVERSARIAL MALFORMED-SCAN & DISAPPEARING-UPPER-BOUND REGRESSIONS
// =============================================================================

test('Adversarial 1: Category B with 1 malformed string offer plus healthy Timestamp offer', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_adv1', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_adv1');
  const res1 = await service.processDispatchJob('job_adv1');
  await offerRef(res1.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  await offerRef('str_bad_1').set({
    status: 'offered',
    expiresAt: 'bad_string_1',
    timeoutTaskState: 'pending',
  });

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  const offHealthy = await read(offerRef(res1.offerId));
  assert.equal(offHealthy.timeoutTaskState, 'enqueued');

  assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, 'str_bad_1');
  if (cp.pendingEnqueueSweep.upperBound.offerId !== null) {
    assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, 'str_bad_1');
  }

  const offBad = await read(offerRef('str_bad_1'));
  assert.equal(offBad.status, 'offered');
  assert.equal(offBad.expiresAt, 'bad_string_1');
});

test('Adversarial 2: Category B with 25 malformed string offers plus healthy Timestamp offer', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_adv25', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_adv25');
  const res25 = await service.processDispatchJob('job_adv25');
  await offerRef(res25.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  for (let i = 1; i <= 25; i++) {
    await offerRef(`str_bad_25_${i}`).set({
      status: 'offered',
      expiresAt: `bad_string_${i}`,
      timeoutTaskState: 'pending',
    });
  }

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  const offHealthy = await read(offerRef(res25.offerId));
  assert.equal(offHealthy.timeoutTaskState, 'enqueued');

  for (let i = 1; i <= 25; i++) {
    assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, `str_bad_25_${i}`);
    if (cp.pendingEnqueueSweep.upperBound.offerId !== null) {
      assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, `str_bad_25_${i}`);
    }
  }
});

test('Adversarial 3: Category B with 26 malformed string offers (exceeding old limit(25)) plus healthy Timestamp offer', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_adv26', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_adv26');
  const res26 = await service.processDispatchJob('job_adv26');
  await offerRef(res26.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  for (let i = 1; i <= 26; i++) {
    await offerRef(`str_bad_26_${i}`).set({
      status: 'offered',
      expiresAt: `bad_string_${i}`,
      timeoutTaskState: 'pending',
    });
  }

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  const offHealthy = await read(offerRef(res26.offerId));
  assert.equal(offHealthy.timeoutTaskState, 'enqueued');

  for (let i = 1; i <= 26; i++) {
    assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, `str_bad_26_${i}`);
    if (cp.pendingEnqueueSweep.upperBound.offerId !== null) {
      assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, `str_bad_26_${i}`);
    }
  }
});

test('Adversarial 4: Category B with 100 malformed string offers plus healthy Timestamp offer', async () => {
  const fakeQueue = new FakeTaskQueue();
  const taskQueueService = createTaskQueueService({ functions: { taskQueue: () => fakeQueue } });
  const service = createDispatchService({ db, now });

  await seedDriver('driver_adv100', { location: new GeoPoint(18.525, 73.86) });
  await seedJob('job_adv100');
  const res100 = await service.processDispatchJob('job_adv100');
  await offerRef(res100.offerId).update({ timeoutTaskState: 'pending', timeoutTaskId: null });

  const batch = db.batch();
  for (let i = 1; i <= 100; i++) {
    batch.set(offerRef(`str_bad_100_${i}`), {
      status: 'offered',
      expiresAt: `bad_string_${i}`,
      timeoutTaskState: 'pending',
    });
  }
  await batch.commit();

  const recovery = createDispatchRecovery({ db, now, service, taskQueueService, batchSize: 10 });
  await recovery.reconcileOfferTimeouts({ maxPendingScannedPerInvocation: 10 });

  const cp = (await db.doc('dispatch_config/recovery_checkpoints').get()).data();
  validateRecoveryCheckpoint(cp, T);

  const offHealthy = await read(offerRef(res100.offerId));
  assert.equal(offHealthy.timeoutTaskState, 'enqueued');

  assert.notEqual(cp.pendingEnqueueSweep.cursor.offerId, 'str_bad_100_1');
  if (cp.pendingEnqueueSweep.upperBound.offerId !== null) {
    assert.notEqual(cp.pendingEnqueueSweep.upperBound.offerId, 'str_bad_100_1');
  }
});

test('Adversarial 5 / Lifecycle: transient A failure -> B success -> upper-bound C disappears -> malformed tail exists -> sweep completes -> next epoch revisits A', async () => {
  const service = createDispatchService({ db, now });
  await seedDriver('driver_a', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_b', { location: new GeoPoint(18.525, 73.86) });
  await seedDriver('driver_c', { location: new GeoPoint(18.525, 73.86) });

  await seedJob('job_a');
  await seedJob('job_b');
  await seedJob('job_c');

  await service.processDispatchJob('job_a');
  clock += 1000;
  await service.processDispatchJob('job_b');
  clock += 1000;
  await service.processDispatchJob('job_c');

  clock += 45000;

  await jobRef('job_tail_str').set({ status: 'offered', offerExpiresAt: 'string_tail_beyond_c' });
  await jobRef('job_tail_num').set({ status: 'offered', offerExpiresAt: 0 });

  let failA = true;
  const realTm = createOfferTimeoutManager({ db, now, dispatchService: service });
  const flakyTm = {
    expireOfferTimeout: async (params) => {
      if (params.jobId === 'job_a' && failA) {
        throw new Error('TRANSIENT_NETWORK_FAILURE');
      }
      return realTm.expireOfferTimeout(params);
    },
    convergeTaskMarker: (p) => realTm.convergeTaskMarker(p),
  };

  const recovery = createDispatchRecovery({ db, now, service, timeoutManager: flakyTm, batchSize: 1 });

  await assert.rejects(
    async () => { await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 2, dueBatchSize: 1 }); },
    /RECOVERY_INCOMPLETE/
  );

  const ref = db.doc('dispatch_config/recovery_checkpoints');
  const cpMid = (await ref.get()).data();
  assert.equal(cpMid.dueOfferSweep.sweepEpoch, 1);
  assert.equal(cpMid.dueOfferSweep.cursor.jobId, 'job_b');
  assert.equal(cpMid.dueOfferSweep.upperBound.jobId, 'job_c');

  const jA1 = await read(jobRef('job_a'));
  assert.equal(jA1.status, 'offered');
  const jB1 = await read(jobRef('job_b'));
  assert.ok(jB1.stateVersion > 1);

  // Upper bound C disappears!
  await jobRef('job_c').delete();

  // Bounded scan with endAt(C) completes the sweep without touching malformed tail
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 10 });

  const cpSweepDone = (await ref.get()).data();
  assert.equal(cpSweepDone.dueOfferSweep.sweepEpoch, 2);
  assert.equal(cpSweepDone.dueOfferSweep.cursor.jobId, null);
  assert.equal(cpSweepDone.dueOfferSweep.upperBound.jobId, null);

  const jTailStr = await read(jobRef('job_tail_str'));
  assert.equal(jTailStr.status, 'offered');
  assert.equal(jTailStr.offerExpiresAt, 'string_tail_beyond_c');

  // Next epoch revisits A
  failA = false;
  await recovery.reconcileOfferTimeouts({ maxDueScannedPerInvocation: 10 });

  const jA2 = await read(jobRef('job_a'));
  assert.ok(jA2.stateVersion > 1);
});
