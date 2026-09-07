'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');
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
  getIstMonthString,
  evaluateDriverCancellation,
  validateCanonicalDriverCancelReceipt,
  validateCanonicalAcceptedDriverCancellationOccurrence,
  classifyCustomerCancellationProvenance,
  validateTerminalAcceptedCustomerCancellationProvenance,
  exactKeys,
  timestampsEqual,
  isAuthoritativeTimestamp,
} = require('./dispatchValidation');

function createCancelJobManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  dispatchService = null,
} = {}) {
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function cancelJob({ jobId, offerId, driverUid, requestId } = {}) {
    // 1. Basic syntax and argument validation
    if (typeof jobId !== 'string' || !jobId.length || jobId.includes('/')) {
      throw new DispatchError('JOB_INVALID');
    }
    if (typeof offerId !== 'string' || !offerId.length || offerId.includes('/')) {
      throw new DispatchError('OFFER_INVALID');
    }
    if (typeof driverUid !== 'string' || !driverUid.length || driverUid.includes('/')) {
      throw new DispatchError('DRIVER_INVALID');
    }
    if (typeof requestId !== 'string' || !requestId.length || requestId.includes('/')) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }

    const receiptRef = db.collection('processed_requests').doc(requestId);
    const jobRef = db.collection('jobs').doc(jobId);
    const offerRef = db.collection('job_offers').doc(offerId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const debitLedgerRef = db.collection('wallet_entries').doc('commission_debit:' + jobId + ':' + offerId);
    const creditLedgerRef = db.collection('wallet_entries').doc('driver_cancel_credit:' + jobId + ':' + offerId);

    const result = await db.runTransaction(async tx => {
      // 2. RECEIPT-FIRST CHECK (User Lock 1 + Blocker 3)
      const receiptSnap = await tx.get(receiptRef);
      if (receiptSnap.exists) {
        const receipt = receiptSnap.data();
        validateCanonicalDriverCancelReceipt({
          receipt,
          jobId,
          offerId,
          driverUid,
          requestId,
          TimestampClass,
        });
        return {
          ...receipt.result,
          idempotent: true,
        };
      }

      // 3. Domain Document Reads
      const [
        jobSnap,
        offerSnap,
        driverSnap,
        debitSnap,
        creditSnap,
      ] = await Promise.all([
        tx.get(jobRef),
        tx.get(offerRef),
        tx.get(driverRef),
        tx.get(debitLedgerRef),
        tx.get(creditLedgerRef),
      ]);

      if (!jobSnap.exists || !offerSnap.exists || !driverSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }

      const job = jobSnap.data();
      const offer = offerSnap.data();
      const driver = driverSnap.data();

      // 4. CUSTOMER PRECEDENCE CHECK (Blocker 1 + Blocker 8B + Audit B4 + F2)
      const custProv = classifyCustomerCancellationProvenance(job, TimestampClass);
      if (custProv === 'PENDING' || custProv === 'TERMINAL') {
        if (offer.jobId !== jobId) {
          throw new DispatchError('OFFER_BINDING_MISMATCH');
        }
        if (offer.driverId !== driverUid) {
          throw new DispatchError('OFFER_DRIVER_MISMATCH');
        }
        if (custProv === 'PENDING') {
          if (job.assignedDriver !== driverUid) {
            throw new DispatchError('WRONG_DRIVER');
          }
          if (job.currentOfferId !== offerId) {
            throw new DispatchError('JOB_OFFER_MISMATCH');
          }
          if (offer.dispatchGeneration !== job.dispatchGeneration) {
            throw new DispatchError('OFFER_GENERATION_MISMATCH');
          }
          const runRef = db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(job.dispatchGeneration));
          const runSnap = await tx.get(runRef);
          if (!runSnap.exists) {
            throw new DispatchError('DOCUMENT_NOT_FOUND');
          }
          const run = runSnap.data();
          if (run.jobId !== jobId || run.generation !== job.dispatchGeneration) {
            throw new DispatchError('CANCELLATION_CONFLICT');
          }
          if (run.currentOfferId !== offerId) {
            throw new DispatchError('CANCELLATION_CONFLICT');
          }
        } else if (custProv === 'TERMINAL') {
          const runRef = db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(job.dispatchGeneration));
          const runSnap = await tx.get(runRef);
          if (!runSnap.exists) {
            throw new DispatchError('DOCUMENT_NOT_FOUND');
          }
          validateTerminalAcceptedCustomerCancellationProvenance({
            job,
            offer,
            run: runSnap.data(),
            originalDebitLedger: debitSnap.exists ? debitSnap.data() : null,
            jobId,
            offerId,
            driverUid,
            TimestampClass,
          });
        }

        return {
          cancelled: false,
          reason: 'customer_cancellation_in_progress',
          jobId,
          offerId,
          driverId: driverUid,
        };
      }

      // 5. Run Document Read & Verification
      const dispatchGeneration = offer.dispatchGeneration || job.dispatchGeneration;
      if (!positive(dispatchGeneration)) {
        throw new DispatchError('JOB_RUN_MISMATCH');
      }
      const runRef = db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(dispatchGeneration));
      const runSnap = await tx.get(runRef);
      if (!runSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const run = runSnap.data();

      // 6. Occurrence and Invariants Validation
      const nowMs = typeof now === 'function' ? now().getTime() : (now instanceof Date ? now.getTime() : Date.now());
      const at = timestamp(nowMs);
      const currentMonth = getIstMonthString(nowMs);

      validateCanonicalAcceptedDriverCancellationOccurrence({
        job,
        offer,
        run,
        driver,
        originalDebit: debitSnap.exists ? debitSnap.data() : null,
        creditExists: creditSnap.exists,
        jobId,
        offerId,
        driverUid,
        TimestampClass,
        currentMonth,
        cancellationEventAt: at,
      });

      // 7. Penalty Evaluation & Policy Calculation
      const evalResult = evaluateDriverCancellation({
        policy: offer.cancellationPolicySnapshot,
        driver,
        commissionPaise: job.driverCommissionPaise,
        eventDate: nowMs,
        TimestampClass,
      });

      // Blocker 4: Guard against wallet balance addition overflow
      const balanceAfterBig = BigInt(driver.walletBalance) + BigInt(evalResult.creditPaise);
      if (balanceAfterBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new DispatchError('WALLET_OVERFLOW');
      }
      const balanceAfterPaise = Number(balanceAfterBig);

      // 8. ATOMIC 6-DOCUMENT TRANSACTION WRITES
      // Write 1: jobs/{jobId} -> pending_offer, ready, cleared assignment, increment stateVersion, overwrite forfeitedAmount
      tx.update(jobRef, {
        status: 'pending_offer',
        dispatchState: 'ready',
        assignedDriver: null,
        currentOfferId: null,
        offeredTo: null,
        offeredAt: null,
        offerExpiresAt: null,
        acceptedAt: null,
        commissionDebitEntryId: null,
        dispatchLeaseOwner: null,
        dispatchLeaseUntil: null,
        dispatchNextActionAt: at,
        dispatchLastFailure: null,
        stateVersion: job.stateVersion + 1,
        forfeitedAmount: evalResult.forfeiturePaise,
        updatedAt: at,
      });

      // Write 2: job_offers/{offerId} -> cancelled_driver
      tx.update(offerRef, {
        status: 'cancelled_driver',
        resolvedAt: at,
        resolutionReason: 'driver_cancelled',
        updatedAt: at,
      });

      // Write 3: dispatch_runs/{runId} -> active, candidate[k].outcome = driver_cancelled, excludedDriverIds updated, nextCandidateIndex preserved
      const candidateIndex = offer.candidateIndex;
      const updatedCandidates = run.candidates.map((c, i) =>
        i === candidateIndex ? { ...c, outcome: 'driver_cancelled' } : c
      );
      const excludedDriverIds = Array.isArray(run.excludedDriverIds)
        ? (run.excludedDriverIds.includes(driverUid) ? run.excludedDriverIds : [...run.excludedDriverIds, driverUid])
        : [driverUid];

      tx.update(runRef, {
        status: 'active',
        currentOfferId: null,
        candidates: updatedCandidates,
        excludedDriverIds,
        updatedAt: at,
      });

      // Write 4: drivers/{driverUid} -> clear pointers, credit wallet, monthlyCancelCount, strictMode, bannedUntil
      tx.update(driverRef, {
        activeJobId: null,
        activeOfferId: null,
        walletBalance: balanceAfterPaise,
        monthlyCancelCount: {
          month: evalResult.currentMonth,
          count: evalResult.countAfter,
        },
        strictMode: evalResult.strictModeAfter,
        bannedUntil: evalResult.bannedUntil,
        updatedAt: at,
      });

      // Write 5: wallet_entries/driver_cancel_credit:{jobId}:{offerId}
      tx.create(creditLedgerRef, {
        operationId: 'driver_cancel_credit:' + jobId + ':' + offerId,
        driverId: driverUid,
        jobId,
        offerId,
        type: 'driver_cancel_credit',
        commissionPaise: job.driverCommissionPaise,
        forfeiturePaise: evalResult.forfeiturePaise,
        creditPaise: evalResult.creditPaise,
        deltaPaise: evalResult.creditPaise,
        balanceBeforePaise: driver.walletBalance,
        balanceAfterPaise: balanceAfterPaise,
        cancellationPolicyEvidence: evalResult.evidence,
        sourceRequestId: requestId,
        sourceType: 'driver',
        actorUid: driverUid,
        createdAt: at,
      });

      // Write 6: processed_requests/{requestId}
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
        operation: 'driver_cancel',
        resourceId: jobId + ':' + offerId,
        payloadHash,
        result: {
          cancelled: true,
          driverId: driverUid,
          forfeitedPaise: evalResult.forfeiturePaise,
          jobId,
          offerId,
          refundPaise: evalResult.creditPaise,
        },
      });

      return {
        cancelled: true,
        jobId,
        offerId,
        driverId: driverUid,
        forfeitedPaise: evalResult.forfeiturePaise,
        refundPaise: evalResult.creditPaise,
      };
    });

    // 9. Post-commit cascade acceleration (strictly after successful commit)
    if (result.cancelled && !result.idempotent && dispatchService) {
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
    cancelJob,
  };
}

let defaultCancelJobManager;
function getDefaultCancelJobManager() {
  if (!defaultCancelJobManager) {
    const { getDefaultDispatchService } = require('./dispatchService');
    defaultCancelJobManager = createCancelJobManager({
      dispatchService: getDefaultDispatchService(),
    });
  }
  return defaultCancelJobManager;
}

function createCancelJobCallable({ cancelJobManager } = {}) {
  const handler = async request => {
    const manager = cancelJobManager || getDefaultCancelJobManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    // Blocker 8A: Strict exact keys validation for callable payload
    if (!exactKeys(data, ['jobId', 'offerId', 'requestId'])) {
      throw new HttpsError('invalid-argument', 'Request data must contain exactly jobId, offerId, and requestId');
    }
    const { jobId, offerId, requestId } = data;
    try {
      return await manager.cancelJob({ jobId, offerId, driverUid, requestId });
    } catch (error) {
      if (error instanceof DispatchError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT') httpsCode = 'invalid-argument';
        else if (error.code === 'DOCUMENT_NOT_FOUND') httpsCode = 'not-found';
        else if (error.code === 'WRONG_DRIVER' || error.code === 'OFFER_DRIVER_MISMATCH' || error.code === 'DRIVER_ENGAGEMENT_MISMATCH') {
          httpsCode = 'permission-denied';
        } else if (error.code === 'LEDGER_ALREADY_EXISTS') {
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

const cancelJob = createCancelJobCallable();

module.exports = {
  createCancelJobManager,
  getDefaultCancelJobManager,
  createCancelJobCallable,
  cancelJob,
};