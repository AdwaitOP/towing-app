'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const https = require('firebase-functions/v2/https');
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
  validateAcceptanceDriverEligibility,
  validateCancellationPolicy,
  buildCancellationPolicySnapshot,
  isAuthoritativeTimestamp,
  validateCanonicalAcceptedOccurrence,
  validateCleanOfferedJobState,
} = require('./dispatchValidation');


function createAcceptJobManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
} = {}) {
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function acceptJob({ jobId, offerId, driverUid, requestId = null } = {}) {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/') ||
        typeof offerId !== 'string' || !offerId || offerId.includes('/') ||
        typeof driverUid !== 'string' || !driverUid || driverUid.includes('/')) {
      throw new DispatchError('INVALID_ARGUMENT');
    }
    if (requestId !== null && requestId !== undefined) {
      if (typeof requestId !== 'string' || !requestId || requestId.includes('/')) {
        throw new DispatchError('INVALID_ARGUMENT');
      }
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const offerRef = db.collection('job_offers').doc(offerId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const configRef = db.collection('pricing_config').doc('main');
    const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
    const ledgerRef = db.collection('wallet_entries').doc(ledgerId);
    const outboxId = 'job_accepted:' + jobId + ':' + offerId;
    const outboxRef = db.collection('notification_outbox').doc(outboxId);
    const receiptRef = requestId ? db.collection('processed_requests').doc(requestId) : null;

    return await db.runTransaction(async tx => {
      // 1. Transactional reads
      const [
        jobSnap,
        offerSnap,
        driverSnap,
        configSnap,
        ledgerSnap,
        outboxSnap,
        receiptSnap,
      ] = await Promise.all([
        tx.get(jobRef),
        tx.get(offerRef),
        tx.get(driverRef),
        tx.get(configRef),
        tx.get(ledgerRef),
        tx.get(outboxRef),
        receiptRef ? tx.get(receiptRef) : Promise.resolve(null),
      ]);

      if (!jobSnap.exists || !offerSnap.exists || !driverSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }

      const job = jobSnap.data();
      const offer = offerSnap.data();
      const driver = driverSnap.data();

      // Read run document & historical receipt
      const dispatchGeneration = offer.dispatchGeneration || job.dispatchGeneration;
      if (!positive(dispatchGeneration)) {
        throw new DispatchError('RUN_GENERATION_MISMATCH');
      }
      const runRef = db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(dispatchGeneration));

      const historicalRequestId = offer.acceptRequestId;
      let historicalReceiptSnapPromise = Promise.resolve(null);
      if (historicalRequestId) {
        if (receiptRef && requestId === historicalRequestId) {
          historicalReceiptSnapPromise = Promise.resolve(receiptSnap);
        } else {
          historicalReceiptSnapPromise = tx.get(db.collection('processed_requests').doc(historicalRequestId));
        }
      }

      const [runSnap, historicalReceiptSnap] = await Promise.all([
        tx.get(runRef),
        historicalReceiptSnapPromise,
      ]);

      if (!runSnap.exists) {
        throw new DispatchError('RUN_NOT_FOUND');
      }
      const run = runSnap.data();

      // 2. IDEMPOTENCY / SAFE DUPLICATE ACCEPTANCE CHECK
      if (job.status === 'accepted') {
        if (job.assignedDriver !== driverUid || job.currentOfferId !== offerId) {
          throw new DispatchError('JOB_ALREADY_ASSIGNED');
        }

        validateCanonicalAcceptedOccurrence({
          job,
          offer,
          run,
          driver,
          ledger: ledgerSnap.exists ? ledgerSnap.data() : null,
          outbox: outboxSnap.exists ? outboxSnap.data() : null,
          receipt: receiptSnap && receiptSnap.exists ? receiptSnap.data() : null,
          historicalReceipt: historicalReceiptSnap && historicalReceiptSnap.exists ? historicalReceiptSnap.data() : null,
          jobId,
          offerId,
          driverUid,
          requestId,
          TimestampClass,
        });

        return {
          accepted: true,
          idempotent: true,
          jobId,
          offerId,
          driverId: driverUid,
        };
      }

      // 3. VALIDATING NEW ACCEPTANCE (from status === 'offered')
      if (job.status !== 'offered' || job.dispatchState !== 'offered') {
        throw new DispatchError('JOB_NOT_OFFERED');
      }
      if (job.currentOfferId !== offerId) {
        throw new DispatchError('JOB_OFFER_MISMATCH');
      }
      if (job.offeredTo !== driverUid) {
        throw new DispatchError('WRONG_DRIVER');
      }

      if (offer.status !== 'offered') {
        throw new DispatchError('OFFER_NOT_ACTIVE');
      }
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
        throw new DispatchError('ACCEPTANCE_CONFLICT');
      }

      // Cancellation precedence
      validateAcceptanceCancellationProvenance(job, offer);

      // Clean offered job state
      validateCleanOfferedJobState(job);

      // Expiry validation & exact 45s contract
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

      // Commission paise validation
      if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
        throw new DispatchError('COMMISSION_PAISE_INVALID');
      }
      if (offer.driverCommissionPaise !== job.driverCommissionPaise) {
        throw new DispatchError('COMMISSION_MISMATCH');
      }

      // State version validation
      if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('JOB_STATE_VERSION_INVALID');
      }

      // Active offer run invariants validation
      if (run.status !== 'active') {
        throw new DispatchError('RUN_CONFLICT');
      }
      if (run.finalizedAt !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      validateActiveOfferRun(run, job, offer, jobId, offerId, job.dispatchGeneration);

      // Driver eligibility & wallet balance revalidation
      validateAcceptanceDriverEligibility(driver, job, offerId, nowMs, TimestampClass);

      // Cancellation policy snapshot from pricing_config/main
      if (!configSnap.exists) {
        throw new DispatchError('CONFIG_NOT_FOUND');
      }
      const cancellationPolicy = configSnap.data()?.cancellation_policy;
      validateCancellationPolicy(cancellationPolicy);
      const at = timestamp(nowMs);
      const policySnapshot = buildCancellationPolicySnapshot(cancellationPolicy, at, TimestampClass);

      // Deterministic document existence checks
      if (ledgerSnap.exists) {
        throw new DispatchError('LEDGER_ALREADY_EXISTS');
      }
      if (outboxSnap.exists) {
        throw new DispatchError('OUTBOX_ALREADY_EXISTS');
      }
      if (receiptSnap && receiptSnap.exists) {
        const receipt = receiptSnap.data();
        if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
        throw new DispatchError('REQUEST_ALREADY_PROCESSED');
      }

      // 4. ATOMIC WRITES
      const candidateIndex = offer.candidateIndex;
      const updatedCandidates = run.candidates.map((c, i) => i === candidateIndex ? { ...c, outcome: 'accepted' } : c);
      const newBalance = driver.walletBalance - job.driverCommissionPaise;

      tx.update(jobRef, {
        status: 'accepted',
        dispatchState: 'assigned',
        assignedDriver: driverUid,
        offeredTo: null,
        offeredAt: null,
        offerExpiresAt: null,
        acceptedAt: at,
        commissionDebitEntryId: ledgerId,
        stateVersion: job.stateVersion + 1,
        updatedAt: at,
      });

      tx.update(offerRef, {
        status: 'accepted',
        acceptedAt: at,
        acceptRequestId: requestId || null,
        cancellationPolicySnapshot: policySnapshot,
        updatedAt: at,
      });

      tx.update(runRef, {
        status: 'assigned',
        candidates: updatedCandidates,
        currentOfferId: offerId,
        updatedAt: at,
      });

      tx.update(driverRef, {
        activeOfferId: null,
        activeJobId: jobId,
        walletBalance: newBalance,
        updatedAt: at,
      });

      tx.create(ledgerRef, {
        operationId: ledgerId,
        driverId: driverUid,
        jobId,
        offerId,
        type: 'commission_debit',
        commissionPaise: job.driverCommissionPaise,
        forfeiturePaise: 0,
        creditPaise: 0,
        deltaPaise: -job.driverCommissionPaise,
        balanceBeforePaise: driver.walletBalance,
        balanceAfterPaise: newBalance,
        cancellationPolicyEvidence: null,
        sourceRequestId: requestId || null,
        sourceType: 'driver',
        actorUid: driverUid,
        createdAt: at,
      });

      tx.create(outboxRef, {
        eventId: outboxId,
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
        nextAttemptAt: at,
        attemptCount: 0,
        providerMessageId: null,
        lastErrorCode: null,
        createdAt: at,
        updatedAt: at,
        sentAt: null,
      });

      if (receiptRef) {
        tx.create(receiptRef, {
          requestId,
          status: 'completed',
          type: 'phase4_client_mutation',
          ownerToken: null,
          claimedAt: at,
          leaseUntil: null,
          processedAt: at,
          actorUid: driverUid,
          operation: 'accept',
          resourceId: jobId + ':' + offerId,
          payloadHash: crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex'),
          result: {
            accepted: true,
            jobId,
            offerId,
            driverId: driverUid,
          },
        });
      }

      return {
        accepted: true,
        jobId,
        offerId,
        driverId: driverUid,
      };
    });
  }

  return {
    acceptJob,
  };
}

let defaultManager;
function getDefaultAcceptJobManager() {
  if (!defaultManager) {
    defaultManager = createAcceptJobManager();
  }
  return defaultManager;
}

function createAcceptJobCallable({ acceptJobManager } = {}) {
  const handler = async request => {
    const manager = acceptJobManager || getDefaultAcceptJobManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    const { jobId, offerId, requestId } = data;
    try {
      return await manager.acceptJob({ jobId, offerId, driverUid, requestId });
    } catch (error) {
      if (error instanceof DispatchError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT') httpsCode = 'invalid-argument';
        else if (error.code === 'DOCUMENT_NOT_FOUND') httpsCode = 'not-found';
        else if (error.code === 'WRONG_DRIVER' || error.code === 'OFFER_DRIVER_MISMATCH' || error.code === 'DRIVER_ENGAGEMENT_MISMATCH') {
          httpsCode = 'permission-denied';
        } else if (error.code === 'LEDGER_ALREADY_EXISTS' || error.code === 'JOB_ALREADY_ASSIGNED' || error.code === 'OUTBOX_ALREADY_EXISTS') {
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


const acceptJob = createAcceptJobCallable();

module.exports = {
  createAcceptJobManager,
  getDefaultAcceptJobManager,
  createAcceptJobCallable,
  acceptJob,
};
