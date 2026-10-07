'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value._seconds === 'number') return value._seconds * 1000 + Math.round((value._nanoseconds || 0) / 1e6);
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.round((value.nanoseconds || 0) / 1e6);
  if (typeof value === 'number') return value;
  return 0;
}

function createPrepareDutyActivationManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function prepareDutyActivation(params = {}) {
    const { driverUid } = params;
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }

    const hasSessionId = Object.prototype.hasOwnProperty.call(params, 'sessionId') && params.sessionId !== undefined;
    const hasClientRequestId = Object.prototype.hasOwnProperty.call(params, 'clientRequestId') && params.clientRequestId !== undefined;

    let explicitSessionId = null;
    if (hasSessionId) {
      const sid = params.sessionId;
      if (typeof sid !== 'string' || sid.length === 0 || sid !== sid.trim()) {
        throw new HttpsError('invalid-argument', 'sessionId must be a non-empty canonical string');
      }
      explicitSessionId = sid;
    }

    let explicitClientRequestId = null;
    if (hasClientRequestId) {
      const crid = params.clientRequestId;
      if (typeof crid !== 'string' || crid.length === 0 || crid !== crid.trim()) {
        throw new HttpsError('invalid-argument', 'clientRequestId must be a non-empty canonical string');
      }
      explicitClientRequestId = crid;
    }

    const firestore = getDb();
    const driverRef = firestore.collection('drivers').doc(driverUid);

    return await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(driverRef);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driver = snap.data();

      if (driver.verificationStatus !== 'approved') {
        throw new HttpsError('failed-precondition', 'Driver profile is not approved');
      }
      // Group G (F13): Driver isOnDuty must be a literal boolean
      if (typeof driver.isOnDuty !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver isOnDuty state is invalid or malformed');
      }
      // Legacy migration: absent/undefined activeDutySessionId is permitted for OFF drivers
      const hasActiveSession = Boolean(driver.activeDutySessionId);
      if (driver.isOnDuty === true || hasActiveSession) {
        throw new HttpsError('failed-precondition', 'Driver is already on duty');
      }
      if (driver.activeJobId !== null || driver.activeOfferId !== null) {
        throw new HttpsError('failed-precondition', 'Driver has an active engagement');
      }

      // M3-D-3: Strict dutyGeneration validation and safe increment check
      if (driver.dutyGeneration !== undefined && driver.dutyGeneration !== null) {
        if (!Number.isSafeInteger(driver.dutyGeneration) || driver.dutyGeneration < 0) {
          throw new HttpsError('failed-precondition', `Invalid driver dutyGeneration: ${driver.dutyGeneration}`);
        }
      }
      const currentGen = (Number.isSafeInteger(driver.dutyGeneration) && driver.dutyGeneration >= 0)
        ? driver.dutyGeneration
        : 0;

      if (currentGen >= Number.MAX_SAFE_INTEGER) {
        throw new HttpsError('failed-precondition', 'Cannot increment dutyGeneration: maximum safe integer reached');
      }
      const expectedGeneration = currentGen + 1;

      // Idempotent recovery with collision-resistant request identity or explicit sessionId
      let sessionId;
      let existingIntentRef = null;
      if (explicitSessionId) {
        sessionId = explicitSessionId;
        existingIntentRef = driverRef.collection('activation_intents').doc(sessionId);
      } else if (explicitClientRequestId) {
        const hash = crypto.createHash('sha256').update(explicitClientRequestId).digest('hex').slice(0, 16);
        sessionId = `${driverUid}_${hash}`;
        existingIntentRef = driverRef.collection('activation_intents').doc(sessionId);
      } else {
        sessionId = `${driverUid}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      }

      if (existingIntentRef) {
        const existingSnap = await transaction.get(existingIntentRef);
        if (existingSnap.exists) {
          const intent = existingSnap.data();
          // Finding 4: Preserve terminal request outcomes! Never turn terminal back into pending!
          if (intent.status === 'cancelled' || intent.status === 'activated' || intent.status === 'superseded' || intent.status === 'recovered') {
            throw new HttpsError(
              'failed-precondition',
              `Activation intent already finalized with status: ${intent.status}`,
            );
          }
          if (intent.expiresAt && toMillis(intent.expiresAt) <= Date.now()) {
            throw new HttpsError('failed-precondition', 'Activation intent has expired');
          }
          if (intent.status === 'pending') {
            if (typeof intent.uid !== 'string' || !intent.uid || intent.uid !== intent.uid.trim() || intent.uid !== driverUid) {
              throw new HttpsError('failed-precondition', 'Stored intent uid is missing, malformed, or mismatch');
            }
            if (typeof intent.sessionId !== 'string' || !intent.sessionId || intent.sessionId !== intent.sessionId.trim() || intent.sessionId !== sessionId) {
              throw new HttpsError('failed-precondition', 'Stored intent sessionId is missing, malformed, or mismatch');
            }
            if (!Number.isSafeInteger(intent.generation) || intent.generation < 1 || intent.generation !== expectedGeneration) {
              throw new HttpsError('failed-precondition', 'Stored intent generation is missing, malformed, or mismatch');
            }
            if (!Number.isSafeInteger(intent.attemptSeq) || intent.attemptSeq <= 0) {
              throw new HttpsError('failed-precondition', 'Stored intent attemptSeq is missing or malformed');
            }
            const newAttemptSeq = intent.attemptSeq + 1;
            if (!Number.isSafeInteger(newAttemptSeq)) {
              throw new HttpsError('failed-precondition', 'Cannot increment attemptSeq: maximum safe integer reached');
            }
            const now = FieldValue.serverTimestamp();
            const ttlExpiry = Timestamp.fromMillis(Date.now() + 5 * 60 * 1000); // 5 min TTL
            transaction.update(existingIntentRef, {
              attemptSeq: newAttemptSeq,
              expiresAt: ttlExpiry,
              updatedAt: now,
            });
            return {
              sessionId,
              generation: intent.generation,
              attemptSeq: newAttemptSeq,
              expiresAtMs: ttlExpiry.toMillis(),
              idempotent: true,
            };
          }
          throw new HttpsError('failed-precondition', `Invalid existing intent status: ${intent.status}`);
        }
      }

      const intentRef = driverRef.collection('activation_intents').doc(sessionId);
      const now = FieldValue.serverTimestamp();
      const ttlExpiry = Timestamp.fromMillis(Date.now() + 5 * 60 * 1000); // 5 min TTL

      transaction.set(intentRef, {
        sessionId,
        uid: driverUid,
        status: 'pending',
        generation: expectedGeneration,
        attemptSeq: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: ttlExpiry,
      });

      return {
        sessionId,
        generation: expectedGeneration,
        attemptSeq: 1,
        expiresAtMs: ttlExpiry.toMillis(),
        idempotent: false,
      };
    });
  }

  return { prepareDutyActivation };
}

let defaultManager;
function getDefaultPrepareDutyActivationManager() {
  if (!defaultManager) {
    defaultManager = createPrepareDutyActivationManager();
  }
  return defaultManager;
}

function createPrepareDutyActivationCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultPrepareDutyActivationManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = (request && typeof request.data === 'object' && request.data !== null) ? request.data : {};
    const args = { driverUid };
    if (Object.prototype.hasOwnProperty.call(data, 'clientRequestId')) {
      args.clientRequestId = data.clientRequestId;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'sessionId')) {
      args.sessionId = data.sessionId;
    }
    return await mgr.prepareDutyActivation(args);
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const prepareDutyActivation = createPrepareDutyActivationCallable();

module.exports = {
  createPrepareDutyActivationManager,
  getDefaultPrepareDutyActivationManager,
  createPrepareDutyActivationCallable,
  prepareDutyActivation,
};
