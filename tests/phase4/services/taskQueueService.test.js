'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { FirebaseFunctionsError } = require('firebase-admin/functions');
const {
  taskIdForOfferTimeout,
  isAlreadyExistsError,
  createTaskQueueService,
} = require('../../../firebase/functions/src/services/taskQueueService');
const { FakeTaskQueue } = require('../fakeDeps');

test('taskIdForOfferTimeout: independent hard-coded literal vector match', () => {
  // Independent hard-coded vector for tuple ["job_test", "offer_test", 1]
  // JSON.stringify(["job_test", "offer_test", 1]) === '["job_test","offer_test",1]'
  // SHA-256('["job_test","offer_test",1]') === d1315d470829855e9f17c86794e1fe2063d74792abb36ad0d23ca738de7ef867
  const literalExpectedTaskId = 'task_timeout_d1315d470829855e9f17c86794e1fe2063d74792abb36ad0d23ca738de7ef867';
  const calculatedTaskId = taskIdForOfferTimeout('job_test', 'offer_test', 1);

  assert.equal(calculatedTaskId, literalExpectedTaskId);
  assert.equal(calculatedTaskId.length, 77);
  assert.match(calculatedTaskId, /^task_timeout_[a-f0-9]{64}$/);
});

test('taskIdForOfferTimeout: computes deterministic SHA-256 hashed task ID from canonical tuple', () => {
  const jobId = 'job_test_101';
  const offerId = 'offer_9f83a6b2c1e4';
  const generation = 1;

  const expectedKey = JSON.stringify([jobId, offerId, generation]);
  const expectedHash = crypto.createHash('sha256').update(expectedKey, 'utf8').digest('hex');
  const expectedTaskId = 'task_timeout_' + expectedHash;

  const taskId1 = taskIdForOfferTimeout(jobId, offerId, generation);
  const taskId2 = taskIdForOfferTimeout(jobId, offerId, generation);

  assert.equal(taskId1, expectedTaskId);
  assert.equal(taskId2, taskId1);
});

test('taskIdForOfferTimeout: distinct semantic tuples produce distinct task IDs', () => {
  const baseJob = 'job_1';
  const baseOffer = 'offer_1';
  const baseGen = 1;

  const id1 = taskIdForOfferTimeout(baseJob, baseOffer, baseGen);
  const idDiffJob = taskIdForOfferTimeout('job_2', baseOffer, baseGen);
  const idDiffOffer = taskIdForOfferTimeout(baseJob, 'offer_2', baseGen);
  const idDiffGen = taskIdForOfferTimeout(baseJob, baseOffer, 2);

  assert.notEqual(id1, idDiffJob);
  assert.notEqual(id1, idDiffOffer);
  assert.notEqual(id1, idDiffGen);
});

test('taskIdForOfferTimeout: fails closed on invalid or path-containing inputs', () => {
  assert.throws(() => taskIdForOfferTimeout('', 'offer_1', 1), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job/invalid', 'offer_1', 1), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', '', 1), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', 'offer/invalid', 1), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', 'offer_1', 0), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', 'offer_1', -1), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', 'offer_1', 1.5), { code: 'TASK_IDENTITY_INVALID' });
  assert.throws(() => taskIdForOfferTimeout('job_1', 'offer_1', null), { code: 'TASK_IDENTITY_INVALID' });
});

test('isAlreadyExistsError: correctly classifies task already exists across SDK variants', () => {
  const fbErr = new FirebaseFunctionsError({ code: 'task-already-exists', message: 'Task already exists' });
  assert.equal(fbErr.code, 'functions/task-already-exists');
  assert.equal(isAlreadyExistsError(fbErr), true);

  assert.equal(isAlreadyExistsError({ code: 'functions/task-already-exists' }), true);
  assert.equal(isAlreadyExistsError({ code: 'task-already-exists' }), true);
  assert.equal(isAlreadyExistsError({ code: 6 }), true);
  assert.equal(isAlreadyExistsError({ code: 'ALREADY_EXISTS' }), true);
  assert.equal(isAlreadyExistsError({ status: 409 }), true);
});

test('isAlreadyExistsError: strictly rejects non-duplicate codes even if message contains duplicate wording', () => {
  // HTTP 403 / Permission denied with "already exists" in message must NEVER converge
  assert.equal(isAlreadyExistsError({ status: 403, code: 'PERMISSION_DENIED', message: 'Task already exists in another project' }), false);
  assert.equal(isAlreadyExistsError({ status: 403, code: 'functions/permission-denied', message: 'ALREADY_EXISTS' }), false);
  assert.equal(isAlreadyExistsError({ status: 401, code: 'UNAUTHENTICATED', message: 'The task already exists' }), false);
  assert.equal(isAlreadyExistsError({ status: 400, code: 'INVALID_ARGUMENT', message: 'ALREADY_EXISTS parameter' }), false);
  assert.equal(isAlreadyExistsError({ status: 404, code: 'NOT_FOUND', message: 'already exists' }), false);
  assert.equal(isAlreadyExistsError({ status: 500, code: 'INTERNAL', message: 'already exists' }), false);
  assert.equal(isAlreadyExistsError({ code: 7 }), false);
  assert.equal(isAlreadyExistsError(new Error('Network timeout')), false);
  assert.equal(isAlreadyExistsError(null), false);
  assert.equal(isAlreadyExistsError(undefined), false);
});

test('createTaskQueueService: enqueues task and converts schedule time', async () => {
  const fakeQueue = new FakeTaskQueue();
  const fakeFunctions = { taskQueue: () => fakeQueue };
  const service = createTaskQueueService({ functions: fakeFunctions });

  const scheduleTime = new Date('2026-09-02T12:00:45.000Z');
  const result = await service.enqueueOfferTimeoutTask({
    jobId: 'job_abc',
    offerId: 'offer_xyz',
    dispatchGeneration: 1,
    scheduleTime,
  });

  assert.equal(result.enqueued, true);
  assert.equal(result.alreadyExists, false);
  assert.match(result.taskId, /^task_timeout_[a-f0-9]{64}$/);
  assert.equal(fakeQueue.enqueuedTasks.length, 1);
  assert.deepEqual(fakeQueue.enqueuedTasks[0].payload, {
    jobId: 'job_abc',
    offerId: 'offer_xyz',
    dispatchGeneration: 1,
  });
  assert.equal(fakeQueue.enqueuedTasks[0].options.scheduleTime.getTime(), scheduleTime.getTime());
  assert.equal(fakeQueue.enqueuedTasks[0].options.id, result.taskId);
});

test('createTaskQueueService: handles ALREADY_EXISTS gracefully as successful convergence', async () => {
  const fakeQueue = new FakeTaskQueue();
  const fakeFunctions = { taskQueue: () => fakeQueue };
  const service = createTaskQueueService({ functions: fakeFunctions });

  const scheduleTime = new Date('2026-09-02T12:00:45.000Z');
  const res1 = await service.enqueueOfferTimeoutTask({
    jobId: 'job_abc',
    offerId: 'offer_xyz',
    dispatchGeneration: 1,
    scheduleTime,
  });
  assert.equal(res1.enqueued, true);
  assert.equal(res1.alreadyExists, false);

  // Second enqueue with identical semantic parameters hits ALREADY_EXISTS
  const res2 = await service.enqueueOfferTimeoutTask({
    jobId: 'job_abc',
    offerId: 'offer_xyz',
    dispatchGeneration: 1,
    scheduleTime,
  });
  assert.equal(res2.enqueued, true);
  assert.equal(res2.alreadyExists, true);
  assert.equal(res2.taskId, res1.taskId);
});

test('createTaskQueueService: returns enqueued: false on non-exists errors without throwing', async () => {
  const failingFunctions = {
    taskQueue: () => ({
      enqueue: async () => {
        const err = new Error('Permission denied');
        err.code = 'PERMISSION_DENIED';
        err.status = 403;
        throw err;
      },
    }),
  };
  const service = createTaskQueueService({ functions: failingFunctions });

  const result = await service.enqueueOfferTimeoutTask({
    jobId: 'job_abc',
    offerId: 'offer_xyz',
    dispatchGeneration: 1,
    scheduleTime: new Date(),
  });

  assert.equal(result.enqueued, false);
  assert.equal(result.alreadyExists, false);
  assert.equal(result.code, 'PERMISSION_DENIED');
  assert.match(result.taskId, /^task_timeout_[a-f0-9]{64}$/);
});

test('createTaskQueueService: rejects invalid schedule times', async () => {
  const service = createTaskQueueService({ functions: { taskQueue: () => new FakeTaskQueue() } });
  await assert.rejects(
    () => service.enqueueOfferTimeoutTask({
      jobId: 'job_abc',
      offerId: 'offer_xyz',
      dispatchGeneration: 1,
      scheduleTime: 'invalid-date',
    }),
    { code: 'TASK_SCHEDULE_TIME_INVALID' }
  );
});
