'use strict';

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

function createEndDutySessionManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function endDutySession({ driverUid, sessionId, generation, lifecycleSeq }) {
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId !== sessionId.trim()) {
      throw new HttpsError('invalid-argument', 'sessionId must be a non-empty canonical string');
    }

    const firestore = getDb();
    const driverRef = firestore.collection('drivers').doc(driverUid);

    return await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(driverRef);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driver = snap.data();

      // Guard 1: Active Offer & Active Job Protections
      if (driver.activeOfferId !== null) {
        throw new HttpsError(
          'failed-precondition',
          `Cannot go off duty while job offer is pending (${driver.activeOfferId})`,
        );
      }
      if (driver.activeJobId !== null) {
        throw new HttpsError(
          'failed-precondition',
          `Cannot go off duty while active job is assigned (${driver.activeJobId})`,
        );
      }

      // Group G (F12): Driver isOnDuty must be a literal boolean
      if (typeof driver.isOnDuty !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver isOnDuty state is invalid or malformed');
      }

      // If already OFF, return idempotently
      if (driver.isOnDuty === false) {
        return {
          status: 'already_off',
          dutyState: 'off',
          activeDutySessionId: driver.activeDutySessionId,
          dutyGeneration: driver.dutyGeneration,
        };
      }

      if (generation === undefined || generation === null || !Number.isSafeInteger(generation) || generation < 0) {
        throw new HttpsError('invalid-argument', 'generation is required and must be a non-negative integer');
      }
      if (lifecycleSeq === undefined || lifecycleSeq === null || !Number.isSafeInteger(lifecycleSeq) || lifecycleSeq <= 0) {
        throw new HttpsError('invalid-argument', 'lifecycleSeq is required and must be a positive integer');
      }

      // Group H (F15): Active session ID must be canonical
      if (typeof driver.activeDutySessionId !== 'string' || driver.activeDutySessionId.length === 0 || driver.activeDutySessionId !== driver.activeDutySessionId.trim()) {
        throw new HttpsError('failed-precondition', 'Driver activeDutySessionId is missing or noncanonical');
      }

      // Guard 2: Session Fence
      if (driver.activeDutySessionId !== sessionId) {
        throw new HttpsError(
          'failed-precondition',
          `Session fence rejected: active session is ${driver.activeDutySessionId}, end was for ${sessionId}`,
        );
      }

      // Guard 3: Generation Fence
      if (driver.dutyGeneration !== generation) {
        throw new HttpsError(
          'failed-precondition',
          `Generation fence rejected: active generation is ${driver.dutyGeneration}, end was for ${generation}`,
        );
      }

      // Guard 4: Lifecycle Sequence Fence
      if (driver.lifecycleSeq !== lifecycleSeq) {
        throw new HttpsError(
          'failed-precondition',
          `Lifecycle sequence fence rejected: active sequence is ${driver.lifecycleSeq}, end was for ${lifecycleSeq}`,
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

      return {
        status: 'deactivated',
        dutyState: 'off',
        dutyGeneration: nextGen,
      };
    });
  }

  return { endDutySession };
}

let defaultManager;
function getDefaultEndDutySessionManager() {
  if (!defaultManager) {
    defaultManager = createEndDutySessionManager();
  }
  return defaultManager;
}

function createEndDutySessionCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultEndDutySessionManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const sessionId = request.data?.sessionId;
    const generation = request.data?.generation;
    const lifecycleSeq = request.data?.lifecycleSeq;

    return await mgr.endDutySession({ driverUid, sessionId, generation, lifecycleSeq });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const endDutySession = createEndDutySessionCallable();

module.exports = {
  createEndDutySessionManager,
  getDefaultEndDutySessionManager,
  createEndDutySessionCallable,
  endDutySession,
};
