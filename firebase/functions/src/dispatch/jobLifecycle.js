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
  validateCanonicalStartReceipt,
  validateCanonicalCompleteReceipt,
  validateCanonicalStartingAcceptedOccurrence,
  validateCanonicalInProgressOccurrence,
} = require('./dispatchValidation');

function createJobLifecycleManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
} = {}) {
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function startJob({ jobId, offerId, driverUid, requestId } = {}) {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/') ||
        typeof offerId !== 'string' || !offerId || offerId.includes('/') ||
        typeof driverUid !== 'string' || !driverUid || driverUid.includes('/') ||
        typeof requestId !== 'string' || !requestId || requestId.includes('/')) {
      throw new DispatchError('INVALID_ARGUMENT');
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const offerRef = db.collection('job_offers').doc(offerId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
    const ledgerRef = db.collection('wallet_entries').doc(ledgerId);
    const acceptedOutboxId = 'job_accepted:' + jobId + ':' + offerId;
    const acceptedOutboxRef = db.collection('notification_outbox').doc(acceptedOutboxId);
    const inProgressOutboxId = 'job_in_progress:' + jobId;
    const inProgressOutboxRef = db.collection('notification_outbox').doc(inProgressOutboxId);
    const receiptRef = db.collection('processed_requests').doc(requestId);

    return await db.runTransaction(async tx => {
      // 1. Transactional reads
      const [
        jobSnap,
        offerSnap,
        driverSnap,
        ledgerSnap,
        acceptedOutboxSnap,
        inProgressOutboxSnap,
        receiptSnap,
      ] = await Promise.all([
        tx.get(jobRef),
        tx.get(offerRef),
        tx.get(driverRef),
        tx.get(ledgerRef),
        tx.get(acceptedOutboxRef),
        tx.get(inProgressOutboxRef),
        tx.get(receiptRef),
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
        if (requestId === historicalRequestId) {
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

      // 2. IDEMPOTENCY CHECK: Existing matching receipt for same requestId
      if (receiptSnap.exists) {
        validateCanonicalStartReceipt({
          receipt: receiptSnap.data(),
          jobId,
          offerId,
          driverUid,
          requestId,
          TimestampClass,
        });

        // Completed matching start receipt proves THIS driver started THIS job.
        // Return stored canonical result even if the job has legitimately advanced to completed afterward.
        return {
          started: true,
          idempotent: true,
          jobId,
          offerId,
          driverId: driverUid,
        };
      }

      // 3. Different requestId after job already advanced to in_progress or completed
      if (job.status === 'in_progress' || job.status === 'completed') {
        throw new DispatchError('JOB_NOT_ACCEPTED');
      }

      // 4. Status guards
      if (job.status !== 'accepted') {
        throw new DispatchError('JOB_NOT_ACCEPTED');
      }
      if (offer.status !== 'accepted') {
        throw new DispatchError('OFFER_NOT_ACCEPTED');
      }

      // 5. Outbox collision check
      if (inProgressOutboxSnap.exists) {
        throw new DispatchError('OUTBOX_ALREADY_EXISTS');
      }

      const nowMs = now().getTime();

      // 6. Validate canonical accepted occurrence
      validateCanonicalStartingAcceptedOccurrence({
        job,
        offer,
        run,
        driver,
        ledger: ledgerSnap.exists ? ledgerSnap.data() : null,
        acceptedOutbox: acceptedOutboxSnap.exists ? acceptedOutboxSnap.data() : null,
        historicalReceipt: historicalReceiptSnap && historicalReceiptSnap.exists ? historicalReceiptSnap.data() : null,
        jobId,
        offerId,
        driverUid,
        nowMs,
        TimestampClass,
      });

      // 7. Atomic writes
      const at = timestamp(nowMs);

      tx.update(jobRef, {
        status: 'in_progress',
        inProgressAt: at,
        stateVersion: job.stateVersion + 1,
        updatedAt: at,
      });

      tx.update(offerRef, {
        status: 'in_progress',
        inProgressAt: at,
        updatedAt: at,
      });

      tx.update(runRef, {
        updatedAt: at,
      });

      // Driver doc is NOT updated on startJob: activeJobId remains jobId, activeOfferId remains null

      tx.create(inProgressOutboxRef, {
        eventId: inProgressOutboxId,
        eventType: 'job_in_progress',
        resourceType: 'job',
        resourceId: jobId,
        channel: 'whatsapp',
        recipientKey: 'customer:' + jobId,
        payloadVersion: 1,
        payload: {
          jobId,
          jobStatus: 'in_progress',
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
        operation: 'start_job',
        resourceId: jobId + ':' + offerId,
        payloadHash,
        result: {
          started: true,
          jobId,
          offerId,
          driverId: driverUid,
        },
      });

      return {
        started: true,
        jobId,
        offerId,
        driverId: driverUid,
      };
    });
  }

  async function completeJob({ jobId, offerId, driverUid, requestId } = {}) {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/') ||
        typeof offerId !== 'string' || !offerId || offerId.includes('/') ||
        typeof driverUid !== 'string' || !driverUid || driverUid.includes('/') ||
        typeof requestId !== 'string' || !requestId || requestId.includes('/')) {
      throw new DispatchError('INVALID_ARGUMENT');
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const offerRef = db.collection('job_offers').doc(offerId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const ledgerId = 'commission_debit:' + jobId + ':' + offerId;
    const ledgerRef = db.collection('wallet_entries').doc(ledgerId);
    const acceptedOutboxId = 'job_accepted:' + jobId + ':' + offerId;
    const acceptedOutboxRef = db.collection('notification_outbox').doc(acceptedOutboxId);
    const inProgressOutboxId = 'job_in_progress:' + jobId;
    const inProgressOutboxRef = db.collection('notification_outbox').doc(inProgressOutboxId);
    const completedOutboxId = 'job_completed:' + jobId;
    const completedOutboxRef = db.collection('notification_outbox').doc(completedOutboxId);
    const receiptRef = db.collection('processed_requests').doc(requestId);

    return await db.runTransaction(async tx => {
      // 1. Transactional reads
      const [
        jobSnap,
        offerSnap,
        driverSnap,
        ledgerSnap,
        acceptedOutboxSnap,
        inProgressOutboxSnap,
        completedOutboxSnap,
        receiptSnap,
      ] = await Promise.all([
        tx.get(jobRef),
        tx.get(offerRef),
        tx.get(driverRef),
        tx.get(ledgerRef),
        tx.get(acceptedOutboxRef),
        tx.get(inProgressOutboxRef),
        tx.get(completedOutboxRef),
        tx.get(receiptRef),
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
        if (requestId === historicalRequestId) {
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

      // 2. IDEMPOTENCY CHECK: Existing matching receipt for same requestId
      if (receiptSnap.exists) {
        validateCanonicalCompleteReceipt({
          receipt: receiptSnap.data(),
          jobId,
          offerId,
          driverUid,
          requestId,
          TimestampClass,
        });

        // Completed matching complete receipt proves THIS driver completed THIS job.
        return {
          completed: true,
          idempotent: true,
          jobId,
          offerId,
          driverId: driverUid,
        };
      }

      // 3. Different requestId after job already completed
      if (job.status === 'completed') {
        throw new DispatchError('JOB_NOT_IN_PROGRESS');
      }

      // 4. Status guards
      if (job.status !== 'in_progress') {
        throw new DispatchError('JOB_NOT_IN_PROGRESS');
      }
      if (offer.status !== 'in_progress') {
        throw new DispatchError('OFFER_NOT_IN_PROGRESS');
      }

      // 5. Outbox collision check
      if (completedOutboxSnap.exists) {
        throw new DispatchError('OUTBOX_ALREADY_EXISTS');
      }

      const nowMs = now().getTime();

      // 6. Validate canonical in-progress occurrence
      validateCanonicalInProgressOccurrence({
        job,
        offer,
        run,
        driver,
        ledger: ledgerSnap.exists ? ledgerSnap.data() : null,
        acceptedOutbox: acceptedOutboxSnap.exists ? acceptedOutboxSnap.data() : null,
        inProgressOutbox: inProgressOutboxSnap.exists ? inProgressOutboxSnap.data() : null,
        historicalReceipt: historicalReceiptSnap && historicalReceiptSnap.exists ? historicalReceiptSnap.data() : null,
        jobId,
        offerId,
        driverUid,
        nowMs,
        TimestampClass,
      });

      // 7. Atomic writes
      const at = timestamp(nowMs);

      tx.update(jobRef, {
        status: 'completed',
        completedAt: at,
        dispatchState: 'closed',
        stateVersion: job.stateVersion + 1,
        updatedAt: at,
      });

      tx.update(offerRef, {
        status: 'completed',
        completedAt: at,
        updatedAt: at,
      });

      tx.update(runRef, {
        status: 'completed',
        finalizedAt: at,
        updatedAt: at,
      });

      tx.update(driverRef, {
        activeJobId: null,
        updatedAt: at,
      });

      tx.create(completedOutboxRef, {
        eventId: completedOutboxId,
        eventType: 'job_completed',
        resourceType: 'job',
        resourceId: jobId,
        channel: 'whatsapp',
        recipientKey: 'customer:' + jobId,
        payloadVersion: 1,
        payload: {
          jobId,
          jobStatus: 'completed',
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
        operation: 'complete_job',
        resourceId: jobId + ':' + offerId,
        payloadHash,
        result: {
          completed: true,
          jobId,
          offerId,
          driverId: driverUid,
        },
      });

      return {
        completed: true,
        jobId,
        offerId,
        driverId: driverUid,
      };
    });
  }

  return {
    startJob,
    completeJob,
  };
}

let defaultManager;
function getDefaultJobLifecycleManager() {
  if (!defaultManager) {
    defaultManager = createJobLifecycleManager();
  }
  return defaultManager;
}

function createStartJobCallable({ jobLifecycleManager } = {}) {
  const handler = async request => {
    const manager = jobLifecycleManager || getDefaultJobLifecycleManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    const { jobId, offerId, requestId } = data;
    try {
      return await manager.startJob({ jobId, offerId, driverUid, requestId });
    } catch (error) {
      if (error instanceof DispatchError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT') httpsCode = 'invalid-argument';
        else if (error.code === 'DOCUMENT_NOT_FOUND') httpsCode = 'not-found';
        else if (error.code === 'WRONG_DRIVER' || error.code === 'OFFER_DRIVER_MISMATCH' || error.code === 'DRIVER_ENGAGEMENT_MISMATCH') {
          httpsCode = 'permission-denied';
        } else if (error.code === 'OUTBOX_ALREADY_EXISTS' || error.code === 'REQUEST_ALREADY_PROCESSED' || error.code === 'REQUEST_IN_PROGRESS' || error.code === 'JOB_ALREADY_STARTED') {
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

function createCompleteJobCallable({ jobLifecycleManager } = {}) {
  const handler = async request => {
    const manager = jobLifecycleManager || getDefaultJobLifecycleManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    const { jobId, offerId, requestId } = data;
    try {
      return await manager.completeJob({ jobId, offerId, driverUid, requestId });
    } catch (error) {
      if (error instanceof DispatchError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT') httpsCode = 'invalid-argument';
        else if (error.code === 'DOCUMENT_NOT_FOUND') httpsCode = 'not-found';
        else if (error.code === 'WRONG_DRIVER' || error.code === 'OFFER_DRIVER_MISMATCH' || error.code === 'DRIVER_ENGAGEMENT_MISMATCH') {
          httpsCode = 'permission-denied';
        } else if (error.code === 'OUTBOX_ALREADY_EXISTS' || error.code === 'REQUEST_ALREADY_PROCESSED' || error.code === 'REQUEST_IN_PROGRESS' || error.code === 'JOB_ALREADY_COMPLETED') {
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

const startJob = createStartJobCallable();
const completeJob = createCompleteJobCallable();

module.exports = {
  createJobLifecycleManager,
  getDefaultJobLifecycleManager,
  createStartJobCallable,
  createCompleteJobCallable,
  startJob,
  completeJob,
};
