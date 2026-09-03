'use strict';

const crypto = require('node:crypto');
const { getFunctions, FirebaseFunctionsError } = require('firebase-admin/functions');
const { DispatchError, positive } = require('../dispatch/dispatchValidation');

function taskIdForOfferTimeout(jobId, offerId, dispatchGeneration) {
  if (typeof jobId !== 'string' || !jobId.length || jobId.includes('/') ||
      typeof offerId !== 'string' || !offerId.length || offerId.includes('/') ||
      !positive(dispatchGeneration)) {
    throw new DispatchError('TASK_IDENTITY_INVALID');
  }
  const occurrenceKey = JSON.stringify([jobId, offerId, dispatchGeneration]);
  const taskHash = crypto.createHash('sha256').update(occurrenceKey, 'utf8').digest('hex');
  return 'task_timeout_' + taskHash;
}

function isAlreadyExistsError(error) {
  if (!error || typeof error !== 'object') return false;
  const status = typeof error.status === 'number' ? error.status : (typeof error.httpResponse?.status === 'number' ? error.httpResponse.status : null);
  const code = typeof error.code === 'string' ? error.code : '';
  const numCode = typeof error.code === 'number' ? error.code : null;

  // Structured non-duplicate codes and HTTP statuses must NEVER converge
  if (status === 401 || status === 403 || status === 400 || status === 404 || status === 500) return false;
  if (['permission-denied', 'unauthenticated', 'invalid-argument', 'not-found', 'internal-error',
    'functions/permission-denied', 'functions/unauthenticated', 'functions/invalid-argument',
    'functions/not-found', 'functions/internal-error', 'PERMISSION_DENIED', 'UNAUTHENTICATED',
    'INVALID_ARGUMENT', 'NOT_FOUND', 'INTERNAL'].includes(code)) {
    return false;
  }

  // Exact structured duplicate task indicators
  if (error instanceof FirebaseFunctionsError && (error.code === 'functions/task-already-exists' || error.hasCode?.('task-already-exists'))) return true;
  if (code === 'functions/task-already-exists' || code === 'task-already-exists') return true;
  if (code === 'ALREADY_EXISTS') return true;
  if (numCode === 6) return true;
  if (status === 409) return true;

  return false;
}

function createTaskQueueService({
  functions = null,
  queueName = 'offerTimeout',
} = {}) {
  const getQueue = () => {
    const fns = functions || getFunctions();
    return fns.taskQueue(queueName);
  };

  async function enqueueOfferTimeoutTask({ jobId, offerId, dispatchGeneration, scheduleTime }) {
    const taskId = taskIdForOfferTimeout(jobId, offerId, dispatchGeneration);
    const payload = { jobId, offerId, dispatchGeneration };
    const date = scheduleTime instanceof Date ? scheduleTime :
      (typeof scheduleTime === 'number' ? new Date(scheduleTime) :
        (scheduleTime?.toDate ? scheduleTime.toDate() : null));

    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new DispatchError('TASK_SCHEDULE_TIME_INVALID');
    }

    try {
      const queue = getQueue();
      await queue.enqueue(payload, { id: taskId, scheduleTime: date });
      return { enqueued: true, taskId, alreadyExists: false };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return { enqueued: true, taskId, alreadyExists: true };
      }
      return {
        enqueued: false,
        taskId,
        alreadyExists: false,
        error,
        code: error?.code || 'ENQUEUE_FAILED',
      };
    }
  }

  return {
    taskIdForOfferTimeout,
    isAlreadyExistsError,
    enqueueOfferTimeoutTask,
  };
}

let defaultTaskQueueService;
function getDefaultTaskQueueService() {
  if (!defaultTaskQueueService) defaultTaskQueueService = createTaskQueueService();
  return defaultTaskQueueService;
}

module.exports = {
  taskIdForOfferTimeout,
  isAlreadyExistsError,
  createTaskQueueService,
  getDefaultTaskQueueService,
};
