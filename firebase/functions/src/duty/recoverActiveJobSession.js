'use strict';

const crypto = require('node:crypto');
const { getFirestore, Timestamp, FieldValue, GeoPoint } = require('firebase-admin/firestore');
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

function createRecoverActiveJobSessionManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function recoverActiveJobSession(params = {}) {
    const {
      driverUid,
      activeDutySessionId,
      dutyGeneration,
      lifecycleSeq,
      expectedActiveJobId,
      initialLocation = null,
    } = params;

    // M3-D: Strict authority validators — every required field must be present, correct type, non-blank
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }

    // M3-D-1: clientRequestId presence-aware validation
    const hasClientRequestId = Object.prototype.hasOwnProperty.call(params, 'clientRequestId') && params.clientRequestId !== undefined;
    let explicitClientRequestId = null;
    if (hasClientRequestId) {
      const crid = params.clientRequestId;
      if (typeof crid !== 'string' || crid.length === 0 || crid !== crid.trim()) {
        throw new HttpsError('invalid-argument', 'clientRequestId must be a non-empty canonical string');
      }
      explicitClientRequestId = crid;
    }

    // M3-E: Source epoch authority — all fields REQUIRED and canonical
    if (!activeDutySessionId || typeof activeDutySessionId !== 'string' || activeDutySessionId.length === 0 || activeDutySessionId !== activeDutySessionId.trim()) {
      throw new HttpsError('invalid-argument', 'activeDutySessionId is required and must be a canonical trimmed string');
    }
    if (dutyGeneration === undefined || dutyGeneration === null || !Number.isSafeInteger(dutyGeneration) || dutyGeneration < 0) {
      throw new HttpsError('invalid-argument', 'dutyGeneration is required and must be a non-negative safe integer');
    }
    if (lifecycleSeq === undefined || lifecycleSeq === null || !Number.isSafeInteger(lifecycleSeq) || lifecycleSeq <= 0) {
      throw new HttpsError('invalid-argument', 'lifecycleSeq is required and must be a positive safe integer');
    }
    if (!expectedActiveJobId || typeof expectedActiveJobId !== 'string' || !expectedActiveJobId.trim()) {
      throw new HttpsError('invalid-argument', 'expectedActiveJobId is required and must be a non-blank string');
    }

    let coords = null;
    if (initialLocation) {
      const { lat, lng } = initialLocation;
      if (
        typeof lat === 'number' &&
        typeof lng === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90.0 &&
        lat <= 90.0 &&
        lng >= -180.0 &&
        lng <= 180.0
      ) {
        coords = { lat, lng };
      }
    }

    const firestore = getDb();
    const driverRef = firestore.collection('drivers').doc(driverUid);

    return await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(driverRef);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driver = snap.data();

      // Derive proposed recovery session ID
      const nowMs = Date.now();
      let proposedSessionId;
      if (explicitClientRequestId) {
        const hash = crypto.createHash('sha256').update(explicitClientRequestId).digest('hex').slice(0, 16);
        proposedSessionId = `${driverUid}_rec_${hash}`;
      } else {
        proposedSessionId = `${driverUid}_rec_${nowMs}_${crypto.randomBytes(8).toString('hex')}`;
      }

      // M3-G: Check for EXISTING intent at proposed ID BEFORE anything else
      const intentRef = driverRef.collection('activation_intents').doc(proposedSessionId);
      const existingIntentSnap = await transaction.get(intentRef);

      if (existingIntentSnap.exists) {
        const existingIntent = existingIntentSnap.data();

        if (existingIntent.status === 'recovered') {
          // M3-G + Group I (F17-F18): Exact duplicate recovery verification
          // Must match: exact intent identity, exact source epoch, exact job, exact result generation, and valid worker lifecycle
          const isReady = driver.workerReady === true;
          const hasValidLifecycle = isReady
            ? (Number.isSafeInteger(driver.lifecycleSeq) && driver.lifecycleSeq > 0)
            : (driver.lifecycleSeq === null || driver.lifecycleSeq === undefined || (Number.isSafeInteger(driver.lifecycleSeq) && driver.lifecycleSeq > 0));

          const isExactDuplicate = (
            existingIntent.uid === driverUid &&
            existingIntent.sessionId === proposedSessionId &&
            existingIntent.sourceSessionId === activeDutySessionId &&
            existingIntent.sourceGeneration === dutyGeneration &&
            existingIntent.sourceLifecycleSeq === lifecycleSeq &&
            existingIntent.sourceActiveJobId === expectedActiveJobId &&
            (existingIntent.jobId === undefined || existingIntent.jobId === expectedActiveJobId) &&
            Number.isSafeInteger(existingIntent.generation) &&
            existingIntent.generation >= 0 &&
            driver.isOnDuty === true &&
            driver.activeDutySessionId === proposedSessionId &&
            driver.dutyGeneration === existingIntent.generation &&
            driver.activeJobId === expectedActiveJobId &&
            hasValidLifecycle
          );

          if (isExactDuplicate) {
            return {
              sessionId: proposedSessionId,
              dutyGeneration: existingIntent.generation,
              workerReady: isReady,
              lifecycleSeq: isReady ? driver.lifecycleSeq : (driver.lifecycleSeq || null),
              activeJobId: driver.activeJobId,
              status: 'already_recovered',
            };
          }

          // M3-G: State has diverged (job changed, generation changed, session replaced, ended, etc.)
          throw new HttpsError(
            'failed-precondition',
            `Recovery intent ${proposedSessionId} cannot be reused: state has diverged from original recovery outcome`,
          );
        }

        // M3-G: Collision with non-recovered terminal intent
        throw new HttpsError(
          'failed-precondition',
          `Recovery intent collision: ${proposedSessionId} already exists with status: ${existingIntent.status}`,
        );
      }

      // Guard 1: Must be on duty
      if (driver.isOnDuty !== true) {
        throw new HttpsError('failed-precondition', 'Driver is not on duty');
      }

      // M3-E: Persisted source identity itself must be canonical
      if (
        !driver.activeDutySessionId ||
        typeof driver.activeDutySessionId !== 'string' ||
        driver.activeDutySessionId.length === 0 ||
        driver.activeDutySessionId !== driver.activeDutySessionId.trim()
      ) {
        throw new HttpsError('failed-precondition', 'Stored activeDutySessionId is malformed or non-canonical');
      }
      if (driver.dutyGeneration === undefined || driver.dutyGeneration === null || !Number.isSafeInteger(driver.dutyGeneration) || driver.dutyGeneration < 0) {
        throw new HttpsError('failed-precondition', 'Stored dutyGeneration is malformed');
      }
      if (driver.lifecycleSeq === undefined || driver.lifecycleSeq === null || !Number.isSafeInteger(driver.lifecycleSeq) || driver.lifecycleSeq <= 0) {
        throw new HttpsError('failed-precondition', 'Stored lifecycleSeq is malformed');
      }
      if (!driver.activeJobId) {
        throw new HttpsError('failed-precondition', 'Driver has no active job to recover');
      }
      if (
        typeof driver.activeJobId !== 'string' ||
        driver.activeJobId.length === 0 ||
        driver.activeJobId !== driver.activeJobId.trim() ||
        !/^[a-zA-Z0-9_-]+$/.test(driver.activeJobId)
      ) {
        throw new HttpsError('failed-precondition', 'Driver has no valid active job to recover: Malformed activeJobId format');
      }

      // M3-D-3: Safe generation increment check
      if (driver.dutyGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new HttpsError('failed-precondition', 'Cannot increment dutyGeneration: maximum safe integer reached');
      }
      const nextGen = driver.dutyGeneration + 1;

      // M3-E: Exact source epoch authority — STRICT comparison against stored state
      if (driver.activeDutySessionId !== activeDutySessionId) {
        throw new HttpsError(
          'failed-precondition',
          `Recovery source epoch rejected: active session is ${driver.activeDutySessionId}, recovery claimed ${activeDutySessionId}`,
        );
      }
      if (driver.dutyGeneration !== dutyGeneration) {
        throw new HttpsError(
          'failed-precondition',
          `Recovery source epoch rejected: active generation is ${driver.dutyGeneration}, recovery claimed ${dutyGeneration}`,
        );
      }
      if (driver.lifecycleSeq !== lifecycleSeq) {
        throw new HttpsError(
          'failed-precondition',
          `Recovery source epoch rejected: active lifecycleSeq is ${driver.lifecycleSeq}, recovery claimed ${lifecycleSeq}`,
        );
      }
      if (driver.activeJobId !== expectedActiveJobId) {
        throw new HttpsError(
          'failed-precondition',
          `Recovery source epoch rejected: active job is ${driver.activeJobId}, recovery expected ${expectedActiveJobId}`,
        );
      }

      // Guard 3: Silence threshold (>= 60s) — liveness prerequisite, NOT authority
      const lastHeartbeatMs = toMillis(driver.locationUpdatedAt);
      const lastRecoveredMs = toMillis(driver.lastRecoveredAt);
      const effectiveLastActivityMs = Math.max(lastHeartbeatMs, lastRecoveredMs);
      const silenceMs = nowMs - effectiveLastActivityMs;
      if (effectiveLastActivityMs > 0 && silenceMs < 60 * 1000) {
        throw new HttpsError(
          'failed-precondition',
          `Recovery blocked by silence threshold: active session or recent recovery is still fresh (${Math.round(silenceMs / 1000)}s < 60s silence)`,
        );
      }

      const now = FieldValue.serverTimestamp();

      // M3-H: Driver doc update — lifecycleSeq is NULL (not old value, not zero, not fabricated)
      // workerReady is false until new native worker earns readiness
      const updateData = {
        activeDutySessionId: proposedSessionId,
        workerReady: false,
        dutyGeneration: nextGen,
        lifecycleSeq: null,
        lastRecoveredAt: now,
        updatedAt: now,
      };

      if (coords) {
        updateData.location = new GeoPoint(coords.lat, coords.lng);
        updateData.locationUpdatedAt = now;
      }

      transaction.update(driverRef, updateData);

      // M3-G: Use create() to prevent overwriting any existing record and bind full source + outcome
      transaction.create(intentRef, {
        sessionId: proposedSessionId,
        uid: driverUid,
        status: 'recovered',
        sourceSessionId: activeDutySessionId,
        sourceGeneration: dutyGeneration,
        sourceLifecycleSeq: lifecycleSeq,
        sourceActiveJobId: expectedActiveJobId,
        jobId: expectedActiveJobId,
        generation: nextGen,
        recoveredSessionId: proposedSessionId,
        recoveredDutyGeneration: nextGen,
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
      });

      return {
        sessionId: proposedSessionId,
        dutyGeneration: nextGen,
        workerReady: false,
        lifecycleSeq: null,
        activeJobId: expectedActiveJobId,
        status: 'recovered',
      };
    });
  }

  return { recoverActiveJobSession };
}

let defaultManager;
function getDefaultRecoverActiveJobSessionManager() {
  if (!defaultManager) {
    defaultManager = createRecoverActiveJobSessionManager();
  }
  return defaultManager;
}

function createRecoverActiveJobSessionCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultRecoverActiveJobSessionManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const data = request.data || {};
    const driverUid = request.auth.uid;
    const recArgs = {
      driverUid,
      activeDutySessionId: data.activeDutySessionId,
      dutyGeneration: data.dutyGeneration,
      lifecycleSeq: data.lifecycleSeq,
      expectedActiveJobId: data.expectedActiveJobId,
      initialLocation: data.initialLocation || null,
    };
    if (Object.prototype.hasOwnProperty.call(data, 'clientRequestId')) {
      recArgs.clientRequestId = data.clientRequestId;
    }

    return await mgr.recoverActiveJobSession(recArgs);
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const recoverActiveJobSession = createRecoverActiveJobSessionCallable();

module.exports = {
  createRecoverActiveJobSessionManager,
  getDefaultRecoverActiveJobSessionManager,
  createRecoverActiveJobSessionCallable,
  recoverActiveJobSession,
};
