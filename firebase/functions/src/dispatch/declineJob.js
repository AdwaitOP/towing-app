'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const https = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const onCall = typeof https?.onCall === 'function'
  ? https.onCall
  : ((...args) => {
      const handler = args.length === 1 ? args[0] : args[1];
      const fn = (...callArgs) => handler(...callArgs);
      fn.run = handler;
      return fn;
    });
const HttpsError = https?.HttpsError || class HttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
};
const {
  DispatchError,
  positive,
  timestampMillis,
  validateActiveOfferRun,
  validateAcceptanceCancellationProvenance,
  isAuthoritativeTimestamp,
  validateCanonicalDeclineReceipt,
} = require('./dispatchValidation');

function createDeclineJobManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  dispatchService = null,
} = {}) {
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function declineJob({ jobId, offerId, driverUid, requestId, triggerCascade = true } = {}) {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/') ||
        typeof offerId !== 'string' || !offerId || offerId.includes('/') ||
        typeof driverUid !== 'string' || !driverUid || driverUid.includes('/') ||
        typeof requestId !== 'string' || !requestId || requestId.includes('/')) {
      throw new DispatchError('INVALID_ARGUMENT');
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const offerRef = db.collection('job_offers').doc(offerId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const receiptRef = db.collection('processed_requests').doc(requestId);

    const result = await db.runTransaction(async tx => {
      // 1. Transactional reads
      const [jobSnap, offerSnap, driverSnap, receiptSnap] = await Promise.all([
        tx.get(jobRef),
        tx.get(offerRef),
        tx.get(driverRef),
        tx.get(receiptRef),
      ]);

      if (!jobSnap.exists || !offerSnap.exists || !driverSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }

      const job = jobSnap.data();
      const offer = offerSnap.data();
      const driver = driverSnap.data();

      // 2. Idempotency Check: Existing matching receipt for same requestId
      if (receiptSnap.exists) {
        validateCanonicalDeclineReceipt({
          receipt: receiptSnap.data(),
          jobId,
          offerId,
          driverUid,
          requestId,
          TimestampClass,
        });

        // Completed matching receipt proves THIS driver declined THIS offer.
        // Return stored canonical result even if the job has legitimately advanced afterward.
        return {
          declined: true,
          idempotent: true,
          jobId,
          offerId,
          driverId: driverUid,
        };
      }

      // 3. Status guards (offer and job)
      if (offer.status !== 'offered') {
        throw new DispatchError('OFFER_NOT_ACTIVE');
      }
      if (job.status !== 'offered' || job.dispatchState !== 'offered') {
        throw new DispatchError('JOB_NOT_OFFERED');
      }
      if (job.currentOfferId !== offerId) {
        throw new DispatchError('JOB_OFFER_MISMATCH');
      }
      if (job.offeredTo !== driverUid) {
        throw new DispatchError('WRONG_DRIVER');
      }

      // Strict Offer Binding Validation
      if (offer.jobId !== jobId) {
        throw new DispatchError('OFFER_BINDING_MISMATCH');
      }
      if (offer.driverId !== driverUid) {
        throw new DispatchError('OFFER_DRIVER_MISMATCH');
      }
      if (offer.dispatchGeneration !== job.dispatchGeneration) {
        throw new DispatchError('OFFER_GENERATION_MISMATCH');
      }
      if (job.dispatchRunId !== String(job.dispatchGeneration)) {
        throw new DispatchError('JOB_RUN_MISMATCH');
      }
      if (offer.acceptedAt != null || offer.inProgressAt != null || offer.completedAt != null ||
          offer.cancellationPolicySnapshot != null || offer.resolvedAt != null ||
          offer.resolutionReason != null || offer.acceptRequestId != null) {
        throw new DispatchError('DECLINE_CONFLICT');
      }

      // 4. Customer cancellation precedence & provenance
      validateAcceptanceCancellationProvenance(job, offer);

      // Clean offered job state
      if (job.assignedDriver != null || job.acceptedAt != null || job.inProgressAt != null ||
          job.completedAt != null || job.commissionDebitEntryId != null) {
        throw new DispatchError('DECLINE_CONFLICT');
      }
      if (job.cancelledAt != null || job.cancelledBy != null || job.cancellationReason != null ||
          job.cancellationResolvedAt != null || (job.cancellationResolutionState != null && job.cancellationResolutionState !== 'none')) {
        throw new DispatchError('DECLINE_CONFLICT');
      }
      if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
          job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
          job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
        throw new DispatchError('DECLINE_CONFLICT');
      }

      // 5. Expiry validation & exact 45s contract
      if (!isAuthoritativeTimestamp(job.offeredAt, TimestampClass) ||
          !isAuthoritativeTimestamp(offer.offeredAt, TimestampClass) ||
          !isAuthoritativeTimestamp(job.offerExpiresAt, TimestampClass) ||
          !isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) {
        throw new DispatchError('OFFER_EXPIRY_INVALID');
      }
      const jobOfferedMs = timestampMillis(job.offeredAt);
      const offerOfferedMs = timestampMillis(offer.offeredAt);
      const jobExpiresMs = timestampMillis(job.offerExpiresAt);
      const offerExpiresMs = timestampMillis(offer.expiresAt);

      if (jobOfferedMs !== offerOfferedMs || jobExpiresMs !== offerExpiresMs) {
        throw new DispatchError('OFFER_EXPIRY_MISMATCH');
      }
      if (offerExpiresMs !== offerOfferedMs + 45000) {
        throw new DispatchError('OFFER_EXPIRY_INVALID');
      }

      const nowMs = now().getTime();
      if (nowMs >= offerExpiresMs) {
        throw new DispatchError('OFFER_EXPIRED');
      }

      // 6. State version validation
      if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('JOB_STATE_VERSION_INVALID');
      }

      // 7. Dispatch Run validation
      const dispatchGeneration = offer.dispatchGeneration;
      if (!positive(dispatchGeneration)) {
        throw new DispatchError('RUN_GENERATION_MISMATCH');
      }
      const runRef = db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(dispatchGeneration));
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) {
        throw new DispatchError('RUN_NOT_FOUND');
      }
      const run = runSnap.data();
      if (run.status !== 'active') {
        throw new DispatchError('RUN_CONFLICT');
      }
      if (run.finalizedAt !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      validateActiveOfferRun(run, job, offer, jobId, offerId, dispatchGeneration);

      // 8. Driver Engagement Validation
      if (driver.activeOfferId !== offerId) {
        throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
      }
      if (driver.activeJobId !== null) {
        throw new DispatchError('ACTIVE_JOB_CONFLICT');
      }

      // 9. Atomic mutation writes
      const candidateIndex = offer.candidateIndex;
      const updatedCandidates = run.candidates.map((c, i) => i === candidateIndex ? { ...c, outcome: 'declined' } : c);
      const at = timestamp(nowMs);

      tx.update(offerRef, {
        status: 'declined',
        resolvedAt: at,
        resolutionReason: 'declined_by_driver',
        updatedAt: at,
      });

      tx.update(driverRef, {
        activeOfferId: null,
        updatedAt: at,
      });

      // nextCandidateIndex, attemptedDriverIds, and excludedDriverIds are preserved exactly
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

      const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
      tx.create(receiptRef, {
        requestId,
        status: 'completed',
        type: 'phase4_client_mutation',
        ownerToken: null,
        claimedAt: at,
        leaseUntil: null,
        processedAt: at,
        actorUid: driverUid,
        operation: 'decline',
        resourceId: jobId + ':' + offerId,
        payloadHash,
        result: {
          declined: true,
          jobId,
          offerId,
          driverId: driverUid,
        },
      });

      return {
        declined: true,
        jobId,
        offerId,
        driverId: driverUid,
        candidateIndex,
      };
    });

    // 10. Post-commit cascade acceleration (strictly after commit, acceleration only)
    if (result.declined && !result.idempotent && triggerCascade && dispatchService) {
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

  return {
    declineJob,
  };
}

let defaultDeclineJobManager;
function getDefaultDeclineJobManager() {
  if (!defaultDeclineJobManager) {
    const { getDefaultDispatchService } = require('./dispatchService');
    defaultDeclineJobManager = createDeclineJobManager({
      dispatchService: getDefaultDispatchService(),
    });
  }
  return defaultDeclineJobManager;
}

function createDeclineJobCallable({ declineJobManager } = {}) {
  const handler = async request => {
    const manager = declineJobManager || getDefaultDeclineJobManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    const { jobId, offerId, requestId } = data;
    try {
      return await manager.declineJob({ jobId, offerId, driverUid, requestId });
    } catch (error) {
      if (error instanceof DispatchError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT') httpsCode = 'invalid-argument';
        else if (error.code === 'DOCUMENT_NOT_FOUND') httpsCode = 'not-found';
        else if (error.code === 'WRONG_DRIVER' || error.code === 'OFFER_DRIVER_MISMATCH' || error.code === 'DRIVER_ENGAGEMENT_MISMATCH') {
          httpsCode = 'permission-denied';
        } else if (error.code === 'REQUEST_ALREADY_PROCESSED' || error.code === 'REQUEST_IN_PROGRESS') {
          httpsCode = 'already-exists';
        }
        throw new HttpsError(httpsCode, error.code, { code: error.code });
      }
      throw error;
    }
  };
  const fn = onCall(handler);
  fn.run = handler;
  return fn;
}

const declineJob = createDeclineJobCallable();

module.exports = {
  createDeclineJobManager,
  getDefaultDeclineJobManager,
  createDeclineJobCallable,
  declineJob,
};
