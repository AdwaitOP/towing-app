'use strict';

const admin = require('firebase-admin');
const {
  DispatchError,
  positive,
  isAuthoritativeTimestamp,
  timestampLessThanOrEqual,
  timestampsEqual,
  timestampMillis,
  validateCanonicalCustomerCancelledOfferedOccurrence,
  validateCanonicalCustomerCancelledAcceptedOccurrence,
  validateCanonicalCustomerCancelledInProgressOccurrence,
  validateCanonicalTerminalCustomerCancellationOccurrence,
} = require('./dispatchValidation');

function isEligibleCancellationMarker(data, TimestampClass) {
  if (!data || typeof data !== 'object') return false;
  if (data.cancellationResolutionState !== 'pending') return false;
  if (!['offered', 'accepted', 'in_progress'].includes(data.status)) return false;
  if (data.cancelledBy !== 'customer') return false;
  if (data.cancellationReason !== 'customer_requested') return false;
  if (!isAuthoritativeTimestamp(data.cancellationRequestedAt, TimestampClass)) return false;
  return true;
}

function shouldProcessCustomerCancellation(event, { TimestampClass } = {}) {
  const after = event?.data?.after;
  if (!after || !after.exists) return false;
  const afterData = after.data();
  if (!isEligibleCancellationMarker(afterData, TimestampClass)) return false;

  const before = event?.data?.before;
  if (!before || !before.exists) return true;
  const beforeData = before.data();
  if (!isEligibleCancellationMarker(beforeData, TimestampClass)) return true;

  if (beforeData.status !== afterData.status) return true;

  if (!timestampsEqual(beforeData.cancellationRequestedAt, afterData.cancellationRequestedAt, TimestampClass)) {
    return true;
  }

  return false;
}

function createCustomerCancellationManager({ db, TimestampClass, now = () => new Date() }) {
  if (!db || typeof db.runTransaction !== 'function') {
    throw new DispatchError('INVALID_ARGUMENT');
  }
  if (!TimestampClass || typeof TimestampClass.fromMillis !== 'function') {
    throw new DispatchError('INVALID_ARGUMENT');
  }

  const jobRefFor = jobId => {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/')) throw new DispatchError('JOB_ID_INVALID');
    return db.collection('jobs').doc(jobId);
  };
  const offerRefFor = offerId => {
    if (typeof offerId !== 'string' || !offerId || offerId.includes('/')) throw new DispatchError('OFFER_ID_INVALID');
    return db.collection('job_offers').doc(offerId);
  };
  const driverRefFor = driverUid => {
    if (typeof driverUid !== 'string' || !driverUid || driverUid.includes('/')) throw new DispatchError('DRIVER_ID_INVALID');
    return db.collection('drivers').doc(driverUid);
  };
  const runRefFor = (jobId, runId) => db.collection('jobs/' + jobId + '/dispatch_runs').doc(String(runId));
  const ledgerRefFor = entryId => db.collection('wallet_entries').doc(entryId);
  const outboxRefFor = eventId => db.collection('notification_outbox').doc(eventId);

  function currentMillis() {
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'number') return now;
    if (typeof now === 'function') {
      const val = now();
      if (val instanceof Date) return val.getTime();
      if (typeof val === 'number') return val;
    }
    return Date.now();
  }

  async function resolveCustomerCancellation({ jobId }) {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/')) {
      throw new DispatchError('INVALID_ARGUMENT');
    }

    const jobRef = jobRefFor(jobId);

    return db.runTransaction(async tx => {
      const jobSnap = await tx.get(jobRef);
      if (!jobSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const job = jobSnap.data();

      // 1. TERMINAL IDEMPOTENCY BRANCH
      if (job.status === 'cancelled_customer') {
        if (job.cancellationResolutionState !== 'resolved') {
          throw new DispatchError('CANCELLATION_CONFLICT');
        }
        const wasAssigned = (job.assignedDriver !== null || job.commissionDebitEntryId !== null);
        const outboxRef = outboxRefFor('job_cancelled_customer:' + jobId);
        const outboxSnap = await tx.get(outboxRef);
        if (!outboxSnap.exists) throw new DispatchError('DOCUMENT_NOT_FOUND');
        const cancelledOutbox = outboxSnap.data();

        // Exact offer binding from authoritative terminal provenance (Blocker 3)
        const offerId = job.currentOfferId;
        if (!offerId) throw new DispatchError('CANCELLATION_CONFLICT');

        const offerRef = offerRefFor(offerId);
        const runId = job.dispatchRunId || String(job.dispatchGeneration);
        const runRef = runRefFor(jobId, runId);
        const debitLedgerRef = ledgerRefFor('commission_debit:' + jobId + ':' + offerId);
        const creditLedgerRef = ledgerRefFor('customer_cancel_credit:' + jobId + ':' + offerId);

        const [offerSnap, runSnap, debitSnap, creditSnap] = await Promise.all([
          tx.get(offerRef),
          tx.get(runRef),
          tx.get(debitLedgerRef),
          tx.get(creditLedgerRef),
        ]);

        if (!offerSnap.exists || !runSnap.exists) {
          throw new DispatchError('DOCUMENT_NOT_FOUND');
        }
        const offer = offerSnap.data();
        const driverUid = wasAssigned ? job.assignedDriver : offer.driverId;
        if (!driverUid) throw new DispatchError('CANCELLATION_CONFLICT');
        if (wasAssigned && offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');

        const driverRef = driverRefFor(driverUid);
        const driverSnap = await tx.get(driverRef);
        if (!driverSnap.exists) throw new DispatchError('DOCUMENT_NOT_FOUND');

        if (wasAssigned) {
          if (!debitSnap.exists || !creditSnap.exists) {
            throw new DispatchError('DOCUMENT_NOT_FOUND');
          }
        } else {
          // Blocker 5C: offered cancellation has zero acceptance finance. Both must be absent.
          if (debitSnap.exists || creditSnap.exists) {
            throw new DispatchError('LEDGER_INVALID');
          }
        }

        validateCanonicalTerminalCustomerCancellationOccurrence({
          job,
          offer,
          run: runSnap.data(),
          driver: driverSnap.data(),
          reversalLedger: wasAssigned ? creditSnap.data() : null,
          cancelledOutbox,
          originalDebitLedger: wasAssigned ? debitSnap.data() : null,
          jobId,
          offerId,
          driverUid,
          wasAssigned,
          TimestampClass,
        });

        return {
          resolved: true,
          idempotent: true,
          jobId,
          offerId,
          driverId: driverUid,
          status: 'cancelled_customer',
          refundPaise: wasAssigned ? creditSnap.data().creditPaise : 0,
        };
      }

      // 2. CHECK ELIGIBLE NON-TERMINAL STATUS
      if (!['offered', 'accepted', 'in_progress'].includes(job.status)) {
        throw new DispatchError('CANCELLATION_CONFLICT');
      }

      // 3. CHECK PENDING MARKER
      if (job.cancelledBy !== 'customer' ||
          job.cancellationReason !== 'customer_requested' ||
          job.cancellationResolutionState !== 'pending' ||
          !isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) {
        throw new DispatchError('CANCELLATION_CONFLICT');
      }

      // Pre-resolution stateVersion must be safely incrementable
      if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('JOB_STATE_VERSION_INVALID');
      }

      const runId = job.dispatchRunId || String(job.dispatchGeneration);
      const runRef = runRefFor(jobId, runId);
      const outboxRef = outboxRefFor('job_cancelled_customer:' + jobId);

      // 4. PRE-ASSIGNMENT (OFFERED) RESOLUTION
      if (job.status === 'offered') {
        const offerId = job.currentOfferId;
        const driverUid = job.offeredTo;
        if (!offerId || !driverUid) throw new DispatchError('CANCELLATION_CONFLICT');

        const offerRef = offerRefFor(offerId);
        const driverRef = driverRefFor(driverUid);
        const debitLedgerRef = ledgerRefFor('commission_debit:' + jobId + ':' + offerId);
        const creditLedgerRef = ledgerRefFor('customer_cancel_credit:' + jobId + ':' + offerId);

        const [offerSnap, runSnap, driverSnap, outboxSnap, debitSnap, creditSnap] = await Promise.all([
          tx.get(offerRef),
          tx.get(runRef),
          tx.get(driverRef),
          tx.get(outboxRef),
          tx.get(debitLedgerRef),
          tx.get(creditLedgerRef),
        ]);

        if (!offerSnap.exists || !runSnap.exists || !driverSnap.exists) {
          throw new DispatchError('DOCUMENT_NOT_FOUND');
        }
        if (outboxSnap.exists) {
          throw new DispatchError('CANCELLATION_CONFLICT');
        }
        if (debitSnap.exists || creditSnap.exists) {
          throw new DispatchError('LEDGER_INVALID');
        }

        const offer = offerSnap.data();
        const run = runSnap.data();
        const driver = driverSnap.data();

        validateCanonicalCustomerCancelledOfferedOccurrence({
          job,
          offer,
          run,
          driver,
          jobId,
          offerId,
          driverUid,
          TimestampClass,
        });

        const nowMs = currentMillis();
        const currentTimestamp = TimestampClass.fromMillis(nowMs);

        // Blocker 6: reject future request timestamp with zero writes
        if (!timestampLessThanOrEqual(job.cancellationRequestedAt, currentTimestamp, TimestampClass)) {
          throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
        }
        if (!timestampLessThanOrEqual(offer.offeredAt, currentTimestamp, TimestampClass)) {
          throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
        }

        // Writes
        tx.update(jobRef, {
          status: 'cancelled_customer',
          dispatchState: 'closed', // Blocker 2
          offeredTo: null,
          currentOfferId: offerId, // Blocker 3: PRESERVED
          offeredAt: null,
          offerExpiresAt: null,
          cancellationResolutionState: 'resolved',
          cancellationResolvedAt: currentTimestamp,
          cancelledAt: currentTimestamp,
          stateVersion: job.stateVersion + 1,
          updatedAt: currentTimestamp,
        });

        tx.update(offerRef, {
          status: 'cancelled_customer',
          resolvedAt: currentTimestamp,
          resolutionReason: 'customer_cancelled',
          updatedAt: currentTimestamp,
        });

        tx.update(runRef, {
          status: 'cancelled_customer',
          currentOfferId: offerId, // Blocker 3: PRESERVED
          finalizedAt: currentTimestamp,
          updatedAt: currentTimestamp,
        });

        const driverUpdate = { updatedAt: currentTimestamp };
        if (driver.activeOfferId === offerId) {
          driverUpdate.activeOfferId = null;
        }
        tx.update(driverRef, driverUpdate);

        tx.set(outboxRef, {
          eventId: 'job_cancelled_customer:' + jobId,
          eventType: 'job_cancelled_customer',
          resourceType: 'job',
          resourceId: jobId,
          channel: 'whatsapp',
          recipientKey: 'customer:' + jobId,
          payloadVersion: 1,
          payload: {
            jobId,
            jobStatus: 'cancelled_customer',
            refundAmountPaise: null,
          },
          state: 'pending',
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: currentTimestamp,
          attemptCount: 0,
          providerMessageId: null,
          lastErrorCode: null,
          createdAt: currentTimestamp,
          updatedAt: currentTimestamp,
          sentAt: null,
        });

        return {
          resolved: true,
          jobId,
          offerId,
          driverId: driverUid,
          previousStatus: 'offered',
          status: 'cancelled_customer',
          refundPaise: 0,
        };
      }

      // 5. ASSIGNED (ACCEPTED OR IN_PROGRESS) RESOLUTION
      const driverUid = job.assignedDriver;
      const offerId = job.currentOfferId;
      if (!driverUid || !offerId) throw new DispatchError('CANCELLATION_CONFLICT');

      const offerRef = offerRefFor(offerId);
      const driverRef = driverRefFor(driverUid);
      const debitLedgerId = 'commission_debit:' + jobId + ':' + offerId;
      const debitLedgerRef = ledgerRefFor(debitLedgerId);
      const creditLedgerId = 'customer_cancel_credit:' + jobId + ':' + offerId;
      const creditLedgerRef = ledgerRefFor(creditLedgerId);
      const acceptedOutboxRef = outboxRefFor('job_accepted:' + jobId + ':' + offerId);
      const inProgressOutboxRef = outboxRefFor('job_in_progress:' + jobId);

      const reads = [
        tx.get(offerRef),
        tx.get(runRef),
        tx.get(driverRef),
        tx.get(debitLedgerRef),
        tx.get(creditLedgerRef),
        tx.get(acceptedOutboxRef),
        tx.get(outboxRef),
      ];
      if (job.status === 'in_progress') {
        reads.push(tx.get(inProgressOutboxRef));
      }

      const snaps = await Promise.all(reads);
      const offerSnap = snaps[0];
      const runSnap = snaps[1];
      const driverSnap = snaps[2];
      const debitLedgerSnap = snaps[3];
      const creditLedgerSnap = snaps[4];
      const acceptedOutboxSnap = snaps[5];
      const outboxSnap = snaps[6];
      const inProgressOutboxSnap = job.status === 'in_progress' ? snaps[7] : null;

      if (!offerSnap.exists || !runSnap.exists || !driverSnap.exists || !debitLedgerSnap.exists || !acceptedOutboxSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      if (job.status === 'in_progress' && (!inProgressOutboxSnap || !inProgressOutboxSnap.exists)) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      if (creditLedgerSnap.exists) {
        throw new DispatchError('LEDGER_INVALID');
      }
      if (outboxSnap.exists) {
        throw new DispatchError('CANCELLATION_CONFLICT');
      }

      const offer = offerSnap.data();
      const run = runSnap.data();
      const driver = driverSnap.data();
      const debit = debitLedgerSnap.data();

      let historicalReceipt = null;
      if (offer.acceptRequestId !== null) {
        const receiptSnap = await tx.get(db.collection('processed_requests').doc(offer.acceptRequestId));
        historicalReceipt = receiptSnap.exists ? receiptSnap.data() : null;
      }

      if (job.status === 'accepted') {
        validateCanonicalCustomerCancelledAcceptedOccurrence({
          job,
          offer,
          run,
          driver,
          ledger: debit,
          acceptedOutbox: acceptedOutboxSnap.data(),
          historicalReceipt,
          jobId,
          offerId,
          driverUid,
          TimestampClass,
        });
      } else {
        validateCanonicalCustomerCancelledInProgressOccurrence({
          job,
          offer,
          run,
          driver,
          ledger: debit,
          acceptedOutbox: acceptedOutboxSnap.data(),
          inProgressOutbox: inProgressOutboxSnap.data(),
          historicalReceipt,
          jobId,
          offerId,
          driverUid,
          TimestampClass,
        });
      }

      // Blocker 4: Positive commission validation & driver wallet checks
      if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0 ||
          !Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise <= 0 ||
          !Number.isSafeInteger(debit.commissionPaise) || debit.commissionPaise <= 0 ||
          job.driverCommissionPaise !== offer.driverCommissionPaise ||
          job.driverCommissionPaise !== debit.commissionPaise) {
        throw new DispatchError('LEDGER_INVALID');
      }
      if (!Number.isSafeInteger(debit.deltaPaise) || debit.deltaPaise !== -debit.commissionPaise) {
        throw new DispatchError('LEDGER_INVALID');
      }
      if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) {
        throw new DispatchError('LEDGER_INVALID');
      }

      const refundCommissionPaise = debit.commissionPaise;
      const balanceBefore = driver.walletBalance;
      const balanceAfter = balanceBefore + refundCommissionPaise;
      if (!Number.isSafeInteger(balanceAfter) || balanceAfter <= balanceBefore) {
        throw new DispatchError('LEDGER_INVALID');
      }

      const nowMs = currentMillis();
      const currentTimestamp = TimestampClass.fromMillis(nowMs);

      // Blocker 6: reject future request timestamp with zero writes
      if (!timestampLessThanOrEqual(job.cancellationRequestedAt, currentTimestamp, TimestampClass)) {
        throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      }
      if (!timestampLessThanOrEqual(offer.acceptedAt, currentTimestamp, TimestampClass)) {
        throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      }
      if (job.status === 'in_progress' && !timestampLessThanOrEqual(job.inProgressAt, currentTimestamp, TimestampClass)) {
        throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      }

      tx.update(jobRef, {
        status: 'cancelled_customer',
        dispatchState: 'closed', // Blocker 2
        currentOfferId: offerId, // Blocker 3: PRESERVED
        cancellationResolutionState: 'resolved',
        cancellationResolvedAt: currentTimestamp,
        cancelledAt: currentTimestamp,
        stateVersion: job.stateVersion + 1,
        updatedAt: currentTimestamp,
      });

      tx.update(offerRef, {
        status: 'cancelled_customer',
        resolvedAt: currentTimestamp,
        resolutionReason: 'customer_cancelled',
        updatedAt: currentTimestamp,
      });

      tx.update(runRef, {
        status: 'cancelled_customer',
        currentOfferId: offerId, // Blocker 3: PRESERVED
        finalizedAt: currentTimestamp,
        updatedAt: currentTimestamp,
      });

      const driverUpdate = {
        walletBalance: balanceAfter,
        updatedAt: currentTimestamp,
      };
      if (driver.activeJobId === jobId) {
        driverUpdate.activeJobId = null;
      }
      if (driver.activeOfferId === offerId) {
        driverUpdate.activeOfferId = null;
      }
      tx.update(driverRef, driverUpdate);

      // Blocker 7: Customer cancel credit with ONLY schema-approved fields (no entryId, no updatedAt)
      tx.set(creditLedgerRef, {
        operationId: creditLedgerId,
        driverId: driverUid,
        jobId: jobId,
        offerId: offerId,
        type: 'customer_cancel_credit',
        commissionPaise: refundCommissionPaise,
        forfeiturePaise: 0,
        creditPaise: refundCommissionPaise,
        deltaPaise: refundCommissionPaise,
        balanceBeforePaise: balanceBefore,
        balanceAfterPaise: balanceAfter,
        cancellationPolicyEvidence: null,
        sourceType: 'customer',
        actorUid: null,
        sourceRequestId: null,
        createdAt: currentTimestamp,
      });

      tx.set(outboxRef, {
        eventId: 'job_cancelled_customer:' + jobId,
        eventType: 'job_cancelled_customer',
        resourceType: 'job',
        resourceId: jobId,
        channel: 'whatsapp',
        recipientKey: 'customer:' + jobId,
        payloadVersion: 1,
        payload: {
          jobId,
          jobStatus: 'cancelled_customer',
          refundAmountPaise: null,
        },
        state: 'pending',
        ownerToken: null,
        leaseUntil: null,
        nextAttemptAt: currentTimestamp,
        attemptCount: 0,
        providerMessageId: null,
        lastErrorCode: null,
        createdAt: currentTimestamp,
        updatedAt: currentTimestamp,
        sentAt: null,
      });

      return {
        resolved: true,
        jobId,
        offerId,
        driverId: driverUid,
        previousStatus: job.status,
        status: 'cancelled_customer',
        refundPaise: refundCommissionPaise,
        reversalCreditEntryId: creditLedgerId,
      };
    });
  }

  async function reconcileCustomerCancellations({ batchSize = 25 } = {}) {
    let last = null;
    const counts = { discovered: 0, resolved: 0, failed: 0, errors: {} };
    do {
      let query = db.collection('jobs')
        .where('cancellationResolutionState', '==', 'pending')
        .orderBy('cancellationRequestedAt', 'asc')
        .limit(batchSize);
      if (last) query = query.startAfter(last);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        counts.discovered++;
        try {
          const result = await resolveCustomerCancellation({ jobId: doc.id });
          if (result && result.resolved) counts.resolved++;
        } catch (err) {
          counts.failed++;
          const reason = typeof err?.code === 'string' ? err.code : (err?.message || 'ERROR');
          counts.errors[reason] = (counts.errors[reason] || 0) + 1;
        }
      }
      last = page.docs[page.docs.length - 1];
      if (page.size < batchSize) break;
    } while (last);

    if (counts.failed > 0) {
      throw new DispatchError('RECONCILIATION_INCOMPLETE', { retryable: true });
    }
    return counts;
  }

  return {
    resolveCustomerCancellation,
    reconcileCustomerCancellations,
  };
}

let defaultManager = null;
function getDefaultCustomerCancellationManager() {
  if (!defaultManager) {
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();
    const { Timestamp } = require('firebase-admin/firestore');
    defaultManager = createCustomerCancellationManager({
      db,
      TimestampClass: Timestamp,
      now: () => new Date(),
    });
  }
  return defaultManager;
}

module.exports = {
  createCustomerCancellationManager,
  getDefaultCustomerCancellationManager,
  productionCustomerCancellationManager: getDefaultCustomerCancellationManager,
  shouldProcessCustomerCancellation,
  isEligibleCancellationMarker,
};
