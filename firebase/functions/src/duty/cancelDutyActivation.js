'use strict';

const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

function createCancelDutyActivationManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function cancelDutyActivation({ driverUid, sessionId, generation, lifecycleSeq, attemptSeq }) {
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId !== sessionId.trim()) {
      throw new HttpsError('invalid-argument', 'sessionId must be a non-empty canonical string');
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

      // Group G (F14): Driver isOnDuty must be a literal boolean
      if (typeof driver.isOnDuty !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver isOnDuty state is invalid or malformed');
      }

      // Guard 1: Active Offer & Active Job Protections
      // If sessionId owns duty, cancellation CANNOT bypass active engagements
      if (driver.activeDutySessionId === sessionId) {
        if (driver.activeOfferId !== null) {
          throw new HttpsError(
            'failed-precondition',
            `Cannot cancel duty session while job offer is pending (${driver.activeOfferId})`,
          );
        }
        if (driver.activeJobId !== null) {
          throw new HttpsError(
            'failed-precondition',
            `Cannot cancel duty session while active job is assigned (${driver.activeJobId})`,
          );
        }
      }

      // Group H (F15): Active session ID must be canonical
      if (driver.isOnDuty === true) {
        if (typeof driver.activeDutySessionId !== 'string' || driver.activeDutySessionId.length === 0 || driver.activeDutySessionId !== driver.activeDutySessionId.trim()) {
          throw new HttpsError('failed-precondition', 'Driver activeDutySessionId is missing or noncanonical');
        }
      }

      const isCurrentOwner = driver.isOnDuty === true && driver.activeDutySessionId === sessionId;

      if (isCurrentOwner) {
        if (generation === undefined || generation === null || !Number.isSafeInteger(generation) || generation < 0) {
          throw new HttpsError('invalid-argument', 'generation is required to cancel an active duty session');
        }
        if (lifecycleSeq === undefined || lifecycleSeq === null || !Number.isSafeInteger(lifecycleSeq) || lifecycleSeq <= 0) {
          throw new HttpsError('invalid-argument', 'lifecycleSeq is required to cancel an active duty session');
        }

        if (driver.dutyGeneration !== generation) {
          throw new HttpsError(
            'failed-precondition',
            `Generation fence rejected: active generation is ${driver.dutyGeneration}, cancel was for ${generation}`,
          );
        }
        if (driver.lifecycleSeq !== lifecycleSeq) {
          throw new HttpsError(
            'failed-precondition',
            `Lifecycle sequence fence rejected: active sequence is ${driver.lifecycleSeq}, cancel was for ${lifecycleSeq}`,
          );
        }

        const now = FieldValue.serverTimestamp();
        if (!Number.isSafeInteger(driver.dutyGeneration) || driver.dutyGeneration < 0) {
          throw new HttpsError('failed-precondition', `Invalid driver dutyGeneration: ${driver.dutyGeneration}`);
        }
        if (driver.dutyGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new HttpsError('failed-precondition', 'Cannot increment dutyGeneration: maximum safe integer reached');
        }
        const nextGen = driver.dutyGeneration + 1;

        transaction.update(driverRef, {
          isOnDuty: false,
          workerReady: false,
          activeDutySessionId: null,
          dutyGeneration: nextGen,
          updatedAt: now,
        });

        // M3-A + M3-C + Group F (F16): If associated intent is terminal (activated, cancelled, superseded, recovered),
        // ZERO write to the intent. Associated pending record must only be cancelled if it strictly matches active epoch tuple.
        if (intentSnap.exists) {
          const intent = intentSnap.data();
          const isTerminal = intent.status === 'activated' ||
            intent.status === 'cancelled' ||
            intent.status === 'superseded' ||
            intent.status === 'recovered';
          if (!isTerminal && intent.status === 'pending') {
            const isMatchingPendingIntent =
              typeof intent.uid === 'string' && intent.uid.length > 0 && intent.uid === intent.uid.trim() && intent.uid === driverUid &&
              typeof intent.sessionId === 'string' && intent.sessionId.length > 0 && intent.sessionId === intent.sessionId.trim() && intent.sessionId === sessionId &&
              Number.isSafeInteger(intent.generation) && intent.generation === generation &&
              Number.isSafeInteger(intent.attemptSeq) && intent.attemptSeq > 0;

            if (isMatchingPendingIntent) {
              transaction.update(intentRef, {
                status: 'cancelled',
                cancelledAt: now,
                updatedAt: now,
              });
            }
          }
        }

        return {
          status: 'deactivated',
          dutyState: 'off',
          dutyGeneration: nextGen,
        };
      }

      // If the session is NOT active on the driver (e.g. pending intent before start, or already ended/superseded)
      const now = FieldValue.serverTimestamp();
      const ttlExpiry = Timestamp.fromMillis(Date.now() + 15 * 60 * 1000);

      if (intentSnap.exists) {
        const intent = intentSnap.data();
        if (intent.status === 'activated' || intent.status === 'cancelled' ||
            intent.status === 'superseded' || intent.status === 'recovered') {
          return {
            status: 'cancelled_unaffected',
            dutyState: driver.isOnDuty ? 'on' : 'off',
            activeDutySessionId: driver.activeDutySessionId,
          };
        }
        if (intent.status === 'pending') {
          // M3-D-2 + Group F (F11): Stored pending intent must strictly bind uid, sessionId, generation, and attemptSeq
          let isAuthorized = false;
          const hasValidStoredUid = typeof intent.uid === 'string' && intent.uid.length > 0 && intent.uid === intent.uid.trim() && intent.uid === driverUid;
          const hasValidStoredSessionId = typeof intent.sessionId === 'string' && intent.sessionId.length > 0 && intent.sessionId === intent.sessionId.trim() && intent.sessionId === sessionId;
          const hasValidStoredGeneration = intent.generation !== undefined && intent.generation !== null && Number.isSafeInteger(intent.generation) && intent.generation >= 0;
          const hasValidStoredAttemptSeq = intent.attemptSeq !== undefined && intent.attemptSeq !== null && Number.isSafeInteger(intent.attemptSeq) && intent.attemptSeq > 0;

          if (hasValidStoredUid && hasValidStoredSessionId && hasValidStoredGeneration && hasValidStoredAttemptSeq) {
            const genMatches = generation !== undefined && generation !== null && Number.isSafeInteger(generation) && generation === intent.generation;
            const attemptMatches = attemptSeq !== undefined && attemptSeq !== null && Number.isSafeInteger(attemptSeq) && attemptSeq === intent.attemptSeq;
            if (genMatches && attemptMatches) {
              isAuthorized = true;
            }
          }

          if (isAuthorized) {
            transaction.update(intentRef, {
              status: 'cancelled',
              cancelledAt: now,
              updatedAt: now,
            });
          }

          return {
            status: 'cancelled_unaffected',
            dutyState: driver.isOnDuty ? 'on' : 'off',
            activeDutySessionId: driver.activeDutySessionId,
          };
        }
        return {
          status: 'cancelled_unaffected',
          dutyState: driver.isOnDuty ? 'on' : 'off',
          activeDutySessionId: driver.activeDutySessionId,
        };
      } else {
        return {
          status: 'cancelled_unaffected',
          dutyState: driver.isOnDuty ? 'on' : 'off',
          activeDutySessionId: driver.activeDutySessionId,
        };
      }
    });
  }

  return { cancelDutyActivation };
}

let defaultManager;
function getDefaultCancelDutyActivationManager() {
  if (!defaultManager) {
    defaultManager = createCancelDutyActivationManager();
  }
  return defaultManager;
}

function createCancelDutyActivationCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultCancelDutyActivationManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const sessionId = request.data?.sessionId;
    const generation = request.data?.generation;
    const lifecycleSeq = request.data?.lifecycleSeq;
    const attemptSeq = request.data?.attemptSeq;

    return await mgr.cancelDutyActivation({ driverUid, sessionId, generation, lifecycleSeq, attemptSeq });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const cancelDutyActivation = createCancelDutyActivationCallable();

module.exports = {
  createCancelDutyActivationManager,
  getDefaultCancelDutyActivationManager,
  createCancelDutyActivationCallable,
  cancelDutyActivation,
};
