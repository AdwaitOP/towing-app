'use strict';

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { logger } = require('firebase-functions');
const {
  DispatchError, positive, timestampMillis, absent, validateActiveOfferRun,
} = require('./dispatchValidation');
const { createTaskQueueService } = require('../services/taskQueueService');

function createOfferTimeoutManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  dispatchService = null,
  taskQueueService = null,
} = {}) {
  const tasks = taskQueueService || createTaskQueueService();
  const jobRefFor = jobId => {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/')) throw new DispatchError('JOB_ID_INVALID');
    return db.collection('jobs').doc(jobId);
  };
  const offerRefFor = offerId => {
    if (typeof offerId !== 'string' || !offerId || offerId.includes('/')) throw new DispatchError('OFFER_ID_INVALID');
    return db.collection('job_offers').doc(offerId);
  };
  const runRefFor = (jobId, runId) => db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(runId));
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function convergeTaskMarker({ jobId, offerId, dispatchGeneration, taskId }) {
    if (typeof jobId !== 'string' || !jobId || typeof offerId !== 'string' || !offerId ||
        !positive(dispatchGeneration) || typeof taskId !== 'string' || !taskId) {
      throw new DispatchError('TASK_MARKER_INVALID');
    }
    const jobRef = jobRefFor(jobId);
    const offerRef = offerRefFor(offerId);
    return db.runTransaction(async tx => {
      const jobSnap = await tx.get(jobRef);
      const offerSnap = await tx.get(offerRef);
      if (!jobSnap.exists || !offerSnap.exists) return { converged: false, reason: 'DOCUMENT_NOT_FOUND' };
      const job = jobSnap.data();
      const offer = offerSnap.data();
      if (offer.status !== 'offered' || offer.timeoutTaskState !== 'pending' || offer.timeoutTaskId !== null ||
          offer.jobId !== jobId || offer.dispatchGeneration !== dispatchGeneration ||
          job.status !== 'offered' || job.currentOfferId !== offerId || job.dispatchGeneration !== dispatchGeneration) {
        return { converged: false, reason: 'OFFER_NOT_PENDING_ENQUEUE' };
      }
      const at = timestamp(now().getTime());
      tx.update(offerRef, { timeoutTaskState: 'enqueued', timeoutTaskId: taskId, updatedAt: at });
      return { converged: true, taskId };
    });
  }

  async function expireOfferTimeout({ jobId, offerId, dispatchGeneration, triggerCascade = true }) {
    if (typeof jobId !== 'string' || !jobId || typeof offerId !== 'string' || !offerId || !positive(dispatchGeneration)) {
      throw new DispatchError('EXPIRE_OFFER_INVALID');
    }
    const jobRef = jobRefFor(jobId);
    const offerRef = offerRefFor(offerId);
    const runRef = runRefFor(jobId, dispatchGeneration);

    const result = await db.runTransaction(async tx => {
      const jobSnap = await tx.get(jobRef);
      const offerSnap = await tx.get(offerRef);
      const runSnap = await tx.get(runRef);

      if (!jobSnap.exists || !offerSnap.exists || !runSnap.exists) {
        return { expired: false, reason: 'DOCUMENT_NOT_FOUND' };
      }
      const job = jobSnap.data();
      const offer = offerSnap.data();
      const run = runSnap.data();

      // 1. Status guards (distinguish legitimate stale delivery from active state)
      if (offer.status !== 'offered') {
        return { expired: false, reason: 'OFFER_NOT_ACTIVE' };
      }
      if (job.status !== 'offered' || job.dispatchState !== 'offered' || job.currentOfferId !== offerId) {
        if (job.cancellationRequestedAt !== null || job.cancelledBy === 'customer') {
          return { expired: false, reason: 'CANCELLATION_PRECEDENCE' };
        }
        return { expired: false, reason: 'OFFER_NOT_ACTIVE' };
      }

      // 2. Cancellation provenance validation for active offer
      const hasReq = !absent(job.cancellationRequestedAt);
      const hasResAt = !absent(job.cancellationResolvedAt);
      const hasCanAt = !absent(job.cancelledAt);
      const hasCanBy = !absent(job.cancelledBy);
      const hasReason = !absent(job.cancellationReason);
      const resState = job.cancellationResolutionState;

      const isCleanNoCancellation = !hasReq && !hasResAt && !hasCanAt && !hasCanBy && !hasReason &&
        resState === 'none' && offer.status !== 'cancelled_customer';

      if (!isCleanNoCancellation) {
        const isLegitCustomerCancel = (hasReq && ['pending', 'resolved_customer_cancelled'].includes(resState)) ||
                                      job.cancelledBy === 'customer' ||
                                      offer.status === 'cancelled_customer';
        if (isLegitCustomerCancel && (hasReq || offer.status === 'cancelled_customer')) {
          return { expired: false, reason: 'CANCELLATION_PRECEDENCE' };
        }
        // Contradictory or corrupted cancellation provenance -> FAIL CLOSED with zero writes
        throw new DispatchError('CANCELLATION_PROVENANCE_CONFLICT');
      }

      // 3. Strict Job Binding Validation
      if (job.offeredTo !== offer.driverId) {
        throw new DispatchError('JOB_OFFER_MISMATCH');
      }
      if (job.dispatchGeneration !== dispatchGeneration || job.dispatchRunId !== String(dispatchGeneration)) {
        throw new DispatchError('JOB_RUN_MISMATCH');
      }
      if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('JOB_STATE_VERSION_INVALID');
      }
      const jobExpiresMs = timestampMillis(job.offerExpiresAt);
      const offerExpiresMs = timestampMillis(offer.expiresAt);
      if (!Number.isFinite(jobExpiresMs) || !Number.isFinite(offerExpiresMs) || jobExpiresMs !== offerExpiresMs) {
        throw new DispatchError('OFFER_EXPIRY_MISMATCH');
      }

      // 4. Strict Offer Binding Validation
      if (offer.jobId !== jobId || offer.dispatchGeneration !== dispatchGeneration) {
        throw new DispatchError('OFFER_BINDING_MISMATCH');
      }
      if (typeof offer.driverId !== 'string' || !offer.driverId || offer.driverId.includes('/')) {
        throw new DispatchError('DRIVER_ID_INVALID');
      }
      if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) {
        throw new DispatchError('CANDIDATE_INDEX_INVALID');
      }

      // 5. Strict Run, Cursor, and History Invariant Validation
      validateActiveOfferRun(run, job, offer, jobId, offerId, dispatchGeneration);

      // 6. Strict Driver Engagement Validation
      const driverRef = db.collection('drivers').doc(offer.driverId);
      const driverSnap = await tx.get(driverRef);
      if (!driverSnap.exists) throw new DispatchError('DRIVER_INVALID');
      const driver = driverSnap.data();
      if (driver.activeOfferId !== offerId) {
        throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
      }

      // 7. Authoritative 45-second expiry check: zero early tolerance
      const nowMs = now().getTime();
      if (nowMs < offerExpiresMs) {
        return { expired: false, early: true, reason: 'OFFER_NOT_EXPIRED', expiresAtMs: offerExpiresMs };
      }

      const candidateIndex = offer.candidateIndex;
      const updatedCandidates = run.candidates.map((c, i) => i === candidateIndex ? { ...c, outcome: 'expired' } : c);
      const at = timestamp(nowMs);

      // Atomic mutation
      tx.update(offerRef, {
        status: 'expired',
        resolvedAt: at,
        resolutionReason: 'offer_expired',
        updatedAt: at,
      });
      tx.update(driverRef, {
        activeOfferId: null,
        updatedAt: at,
      });
      tx.update(runRef, {
        candidates: updatedCandidates,
        currentOfferId: null,
        updatedAt: at,
      });
      tx.update(jobRef, {
        status: 'pending_offer',
        dispatchState: 'ready',
        offeredTo: null,
        currentOfferId: null,
        offeredAt: null,
        offerExpiresAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseUntil: null,
        dispatchNextActionAt: at,
        dispatchLastFailure: null,
        stateVersion: job.stateVersion + 1,
        updatedAt: at,
      });

      return {
        expired: true,
        jobId,
        offerId,
        dispatchGeneration,
        driverId: offer.driverId,
        candidateIndex,
      };
    });

    // Cascade acceleration strictly after commit
    if (result.expired && triggerCascade && dispatchService) {
      try {
        await dispatchService.processDispatchJob(jobId);
      } catch (cascadeError) {
        logger.warn('Cascade dispatch acceleration deferred to reconciler', {
          jobId,
          error: cascadeError?.message || cascadeError,
        });
      }
    }

    return result;
  }

  async function handleOfferTimeoutTask(req) {
    const data = req.data || req.body || {};
    const { jobId, offerId, dispatchGeneration } = data;
    if (typeof jobId !== 'string' || !jobId || typeof offerId !== 'string' || !offerId || !positive(dispatchGeneration)) {
      throw new Error('INVALID_TASK_PAYLOAD');
    }
    const result = await expireOfferTimeout({
      jobId,
      offerId,
      dispatchGeneration,
      triggerCascade: true,
    });
    if (result.early) {
      throw new Error('OFFER_NOT_EXPIRED');
    }
    return result;
  }

  return {
    convergeTaskMarker,
    expireOfferTimeout,
    handleOfferTimeoutTask,
  };
}

let defaultTimeoutManager;
function getDefaultTimeoutManager() {
  if (!defaultTimeoutManager) {
    const { getDefaultDispatchService } = require('./dispatchService');
    defaultTimeoutManager = createOfferTimeoutManager({
      dispatchService: getDefaultDispatchService(),
    });
  }
  return defaultTimeoutManager;
}

const offerTimeout = onTaskDispatched({
  retryConfig: { maxAttempts: 5 },
}, async req => {
  return getDefaultTimeoutManager().handleOfferTimeoutTask(req);
});

module.exports = {
  createOfferTimeoutManager,
  getDefaultTimeoutManager,
  offerTimeout,
};
