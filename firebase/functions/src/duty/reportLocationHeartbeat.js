'use strict';

const { getFirestore, FieldValue, GeoPoint } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

function createReportLocationHeartbeatManager({ db = null } = {}) {
  const getDb = () => db || getFirestore();

  async function reportLocationHeartbeat({ driverUid, sessionId, location, generation, lifecycleSeq }) {
    if (!driverUid || typeof driverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'driverUid is required');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId !== sessionId.trim()) {
      throw new HttpsError('invalid-argument', 'sessionId must be a non-empty canonical string');
    }

    if (generation === undefined || generation === null || !Number.isSafeInteger(generation) || generation < 0) {
      throw new HttpsError('invalid-argument', 'generation is required and must be a non-negative integer');
    }
    if (lifecycleSeq === undefined || lifecycleSeq === null || !Number.isSafeInteger(lifecycleSeq) || lifecycleSeq <= 0) {
      throw new HttpsError('invalid-argument', 'lifecycleSeq is required and must be a positive integer');
    }

    const { lat, lng } = location || {};
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
      throw new HttpsError('invalid-argument', 'Valid GPS coordinates are required');
    }

    const firestore = getDb();
    const driverRef = firestore.collection('drivers').doc(driverUid);

    return await firestore.runTransaction(async (transaction) => {
      const snap = await transaction.get(driverRef);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driver = snap.data();

      // Guard 1: Driver must be ON duty
      if (driver.isOnDuty !== true) {
        throw new HttpsError('failed-precondition', 'Driver is not on duty');
      }

      // Group H (F15): Active session ID must be canonical
      if (typeof driver.activeDutySessionId !== 'string' || driver.activeDutySessionId.length === 0 || driver.activeDutySessionId !== driver.activeDutySessionId.trim()) {
        throw new HttpsError('failed-precondition', 'Driver activeDutySessionId is missing or noncanonical');
      }

      // Guard 2: Session Fence — only the active session may submit heartbeats
      if (driver.activeDutySessionId !== sessionId) {
        throw new HttpsError(
          'failed-precondition',
          `Session fence rejected: active session is ${driver.activeDutySessionId}, heartbeat was for ${sessionId}`,
        );
      }

      // Guard 2b: Generation Fence — exact epoch validation
      if (driver.dutyGeneration !== generation) {
        throw new HttpsError(
          'failed-precondition',
          `Generation fence rejected: active generation is ${driver.dutyGeneration}, heartbeat was for ${generation}`,
        );
      }

      // Guard 2c: Lifecycle Sequence — binding or validation
      // M3-H: If lifecycleSeq is null (after recovery), bind the caller's native lifecycleSeq (one-time)
      if (driver.lifecycleSeq === null || driver.lifecycleSeq === undefined) {
        // Recovery lifecycle binding: one-time write of native worker's lifecycleSeq
        const now = FieldValue.serverTimestamp();
        transaction.update(driverRef, {
          location: new GeoPoint(lat, lng),
          locationUpdatedAt: now,
          lifecycleSeq: lifecycleSeq,
          workerReady: true,
          updatedAt: now,
        });
        return {
          success: true,
          workerReady: true,
          lifecycleBound: true,
          dutyGeneration: driver.dutyGeneration || 1,
          lifecycleSeq: lifecycleSeq,
        };
      }

      // Guard 2c (existing): Lifecycle Sequence Fence — exact epoch validation
      if (driver.lifecycleSeq !== lifecycleSeq) {
        throw new HttpsError(
          'failed-precondition',
          `Lifecycle sequence fence rejected: active sequence is ${driver.lifecycleSeq}, heartbeat was for ${lifecycleSeq}`,
        );
      }

      const now = FieldValue.serverTimestamp();

      transaction.update(driverRef, {
        location: new GeoPoint(lat, lng),
        locationUpdatedAt: now,
        workerReady: true,
        updatedAt: now,
      });

      return {
        success: true,
        workerReady: true,
        dutyGeneration: driver.dutyGeneration || 1,
        lifecycleSeq: driver.lifecycleSeq || 1,
      };
    });
  }

  return { reportLocationHeartbeat };
}

let defaultManager;
function getDefaultReportLocationHeartbeatManager() {
  if (!defaultManager) {
    defaultManager = createReportLocationHeartbeatManager();
  }
  return defaultManager;
}

function createReportLocationHeartbeatCallable({ manager } = {}) {
  const handler = async (request) => {
    const mgr = manager || getDefaultReportLocationHeartbeatManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const sessionId = request.data?.sessionId;
    const location = request.data?.location;
    const generation = request.data?.generation;
    const lifecycleSeq = request.data?.lifecycleSeq;

    return await mgr.reportLocationHeartbeat({
      driverUid,
      sessionId,
      location,
      generation,
      lifecycleSeq,
    });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const reportLocationHeartbeat = createReportLocationHeartbeatCallable();

module.exports = {
  createReportLocationHeartbeatManager,
  getDefaultReportLocationHeartbeatManager,
  createReportLocationHeartbeatCallable,
  reportLocationHeartbeat,
};
