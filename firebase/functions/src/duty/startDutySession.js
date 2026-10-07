'use strict';

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

function createStartDutySessionManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function startDutySession({ driverUid, sessionId, initialLocation, lifecycleSeq, generation, attemptSeq }) {
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new HttpsError('invalid-argument', 'sessionId is required');
    }

    if (lifecycleSeq === undefined || lifecycleSeq === null || !Number.isSafeInteger(lifecycleSeq) || lifecycleSeq <= 0) {
      throw new HttpsError('invalid-argument', 'lifecycleSeq must be a positive integer');
    }
    const resolvedLifecycleSeq = lifecycleSeq;

    if (generation === undefined || generation === null || !Number.isSafeInteger(generation) || generation < 0) {
      throw new HttpsError('invalid-argument', 'generation is required and must be a non-negative integer');
    }

    if (attemptSeq !== undefined && attemptSeq !== null && (!Number.isSafeInteger(attemptSeq) || attemptSeq <= 0)) {
      throw new HttpsError('invalid-argument', 'attemptSeq must be a positive integer');
    }

    const { lat, lng } = initialLocation || {};
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90.0 ||
      lat > 90.0 ||
      lng < -180.0 ||
      lng > 180.0
    ) {
      throw new HttpsError('invalid-argument', 'Valid initial GPS coordinates are required');
    }

    const firestore = getDb();
    const driverRef = firestore.collection('drivers').doc(driverUid);
    const intentRef = driverRef.collection('activation_intents').doc(sessionId);

    return await firestore.runTransaction(async (transaction) => {
      const [driverSnap, intentSnap] = await Promise.all([
        transaction.get(driverRef),
        transaction.get(intentRef),
      ]);

      if (!driverSnap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driver = driverSnap.data();

      // Guard 1: Strict Intent Registration Verification
      if (!intentSnap.exists) {
        throw new HttpsError('failed-precondition', 'Activation intent missing or expired');
      }

      const intent = intentSnap.data();

      // Idempotent retry check: must consistently identify the same currently active session
      if (intent.status === 'activated') {
        if (driver.isOnDuty === true && driver.activeDutySessionId === sessionId) {
          // M3-B: Validate generation
          if (!Number.isSafeInteger(driver.dutyGeneration) || driver.dutyGeneration !== generation) {
            throw new HttpsError(
              'failed-precondition',
              `Activation retry rejected: active generation is ${driver.dutyGeneration}, requested was ${generation}`,
            );
          }
          // M3-B: Validate stored lifecycleSeq is well-formed
          if (!Number.isSafeInteger(driver.lifecycleSeq) || driver.lifecycleSeq <= 0) {
            throw new HttpsError(
              'failed-precondition',
              `Activation retry rejected: stored lifecycleSeq is malformed: ${driver.lifecycleSeq}`,
            );
          }
          if (driver.lifecycleSeq !== resolvedLifecycleSeq) {
            throw new HttpsError(
              'failed-precondition',
              `Activation retry rejected: active lifecycleSeq is ${driver.lifecycleSeq}, requested was ${resolvedLifecycleSeq}`,
            );
          }
          return {
            status: 'already_activated',
            dutyGeneration: driver.dutyGeneration,
            lifecycleSeq: driver.lifecycleSeq,
            workerReady: driver.workerReady === true,
          };
        }
        throw new HttpsError(
          'failed-precondition',
          'Activation retry rejected: session already ended or superseded',
        );
      }

      if (intent.status === 'cancelled') {
        throw new HttpsError('cancelled', 'Activation intent was cancelled prior to execution');
      }

      if (intent.status === 'superseded' || intent.status === 'recovered') {
        throw new HttpsError('failed-precondition', `Intent is terminal with status: ${intent.status}`);
      }

      if (intent.status !== 'pending') {
        throw new HttpsError('failed-precondition', `Invalid intent status: ${intent.status}`);
      }

      if (!intent.expiresAt || toMillis(intent.expiresAt) <= Date.now()) {
        throw new HttpsError('deadline-exceeded', 'Activation intent has expired or missing expiry');
      }

      // Guard 2: Driver Must Be Authoritatively OFF (legacy migration: absent activeDutySessionId allowed)
      const hasActiveSession = Boolean(driver.activeDutySessionId);
      if (driver.isOnDuty !== false || hasActiveSession) {
        throw new HttpsError(
          'failed-precondition',
          `Cannot activate session: driver is already on duty under session: ${driver.activeDutySessionId}`,
        );
      }

      // Guard 3: Prerequisites and Engagement Checks
      if (driver.verificationStatus !== 'approved') {
        throw new HttpsError('failed-precondition', 'Driver profile is not approved');
      }
      if (driver.activeJobId !== null || driver.activeOfferId !== null) {
        throw new HttpsError('failed-precondition', 'Cannot activate duty with active engagement');
      }

      // M3-B: Validate STORED intent pending authority fields
      if (!intent.uid || typeof intent.uid !== 'string' || intent.uid !== driverUid) {
        throw new HttpsError('failed-precondition', 'Stored intent uid is missing or mismatch');
      }
      if (
        !intent.sessionId ||
        typeof intent.sessionId !== 'string' ||
        intent.sessionId !== intent.sessionId.trim() ||
        intent.sessionId !== sessionId
      ) {
        throw new HttpsError('failed-precondition', 'Stored intent sessionId is missing, malformed, or mismatch');
      }
      if (intent.generation === undefined || intent.generation === null || !Number.isSafeInteger(intent.generation) || intent.generation < 0) {
        throw new HttpsError('failed-precondition', 'Stored intent generation is missing or malformed');
      }
      if (intent.attemptSeq === undefined || intent.attemptSeq === null || !Number.isSafeInteger(intent.attemptSeq) || intent.attemptSeq <= 0) {
        throw new HttpsError('failed-precondition', 'Stored intent attemptSeq is missing or malformed');
      }

      // M3-D-3: Strict dutyGeneration validation: fractional or negative values fail closed
      if (driver.dutyGeneration !== undefined && driver.dutyGeneration !== null) {
        if (!Number.isSafeInteger(driver.dutyGeneration) || driver.dutyGeneration < 0) {
          throw new HttpsError(
            'failed-precondition',
            `Malformed driver dutyGeneration: must be a non-negative integer, got ${driver.dutyGeneration}`,
          );
        }
      }
      const currentGen = (Number.isSafeInteger(driver.dutyGeneration) && driver.dutyGeneration >= 0)
        ? driver.dutyGeneration
        : 0;

      if (currentGen >= Number.MAX_SAFE_INTEGER) {
        throw new HttpsError('failed-precondition', 'Cannot increment dutyGeneration: maximum safe integer reached');
      }
      const nextGen = currentGen + 1;

      // M3-B: generation is always validated (required at entry)
      if (generation !== nextGen) {
        throw new HttpsError(
          'failed-precondition',
          `Generation mismatch: driver expected next generation is ${nextGen}, requested was ${generation}`,
        );
      }

      if (intent.generation !== nextGen) {
        throw new HttpsError(
          'failed-precondition',
          `Intent generation mismatch: intent is bound to generation ${intent.generation}, but driver expected next generation is ${nextGen}`,
        );
      }

      // M3-B: attemptSeq is REQUIRED
      if (attemptSeq === undefined || attemptSeq === null) {
        if (intent.attemptSeq > 1) {
          throw new HttpsError(
            'failed-precondition',
            'Intent has been reprepared; attemptSeq is required',
          );
        }
        throw new HttpsError('invalid-argument', 'attemptSeq is required and must be a positive integer');
      }
      if (!Number.isSafeInteger(attemptSeq) || attemptSeq <= 0) {
        throw new HttpsError('invalid-argument', 'attemptSeq must be a positive integer');
      }

      if (attemptSeq !== intent.attemptSeq) {
        throw new HttpsError(
          'failed-precondition',
          `Intent attempt sequence mismatch: intent is for attempt ${intent.attemptSeq}, requested was ${attemptSeq}`,
        );
      }

      const now = FieldValue.serverTimestamp();

      // Update Intent to ACTIVATED
      transaction.update(intentRef, {
        status: 'activated',
        dutyGeneration: nextGen,
        lifecycleSeq: resolvedLifecycleSeq,
        activatedAt: now,
        updatedAt: now,
      });

      // Update Driver Document to ON with workerReady = false
      const updateData = {
        isOnDuty: true,
        workerReady: false,
        activeDutySessionId: sessionId,
        dutyGeneration: nextGen,
        lifecycleSeq: resolvedLifecycleSeq,
        location: new GeoPoint(lat, lng),
        locationUpdatedAt: now,
        updatedAt: now,
      };
      transaction.update(driverRef, updateData);

      return {
        status: 'activated',
        dutyGeneration: nextGen,
        lifecycleSeq: resolvedLifecycleSeq,
        workerReady: false,
      };
    });
  }

  return { startDutySession };
}

let defaultManager;
function getDefaultStartDutySessionManager() {
  if (!defaultManager) {
    defaultManager = createStartDutySessionManager();
  }
  return defaultManager;
}

function createStartDutySessionCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultStartDutySessionManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const sessionId = request.data?.sessionId;
    const initialLocation = request.data?.initialLocation;
    const lifecycleSeq = request.data?.lifecycleSeq;
    const generation = request.data?.generation;
    const attemptSeq = request.data?.attemptSeq;

    return await mgr.startDutySession({ driverUid, sessionId, initialLocation, lifecycleSeq, generation, attemptSeq });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const startDutySession = createStartDutySessionCallable();

module.exports = {
  createStartDutySessionManager,
  getDefaultStartDutySessionManager,
  createStartDutySessionCallable,
  startDutySession,
};
