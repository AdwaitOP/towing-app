'use strict';

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');

function createOrphanDutyReaper({ db = null, silenceThresholdSeconds = 240 } = {}) {
  const getDb = () => db || getFirestore();

  async function sweepOrphanedDutyLeases() {
    const firestore = getDb();
    const thresholdMs = silenceThresholdSeconds * 1000;
    const nowMs = Date.now();

    // Query on-duty drivers who do not have an active job or active offer
    const snapshot = await firestore.collection('drivers')
      .where('isOnDuty', '==', true)
      .where('activeJobId', '==', null)
      .where('activeOfferId', '==', null)
      .get();

    const candidates = snapshot.docs;
    const reapedDriverIds = [];

    for (const doc of candidates) {
      const driverId = doc.id;
      const driverRef = firestore.collection('drivers').doc(driverId);

      try {
        const reaped = await firestore.runTransaction(async (transaction) => {
          const freshSnap = await transaction.get(driverRef);
          if (!freshSnap.exists) return false;

          const driver = freshSnap.data();

          // Re-verify the 5 mandatory guards inside transaction:
          // Guard 1: Must be on duty
          if (driver.isOnDuty !== true) return false;

          // Guard 2: Must NOT have an active job
          if (driver.activeJobId !== null) return false;

          // Guard 3: Must NOT have an active offer
          if (driver.activeOfferId !== null) return false;

          // Guard 4: Silence threshold (> 240s)
          let lastHeartbeatMs = 0;
          if (driver.locationUpdatedAt) {
            if (typeof driver.locationUpdatedAt.toMillis === 'function') {
              lastHeartbeatMs = driver.locationUpdatedAt.toMillis();
            } else if (driver.locationUpdatedAt instanceof Date) {
              lastHeartbeatMs = driver.locationUpdatedAt.getTime();
            }
          }

          // If recently updated (< 240s), not an orphan
          if (lastHeartbeatMs > 0 && (nowMs - lastHeartbeatMs) <= thresholdMs) {
            return false;
          }

          // Guard 5: Driver exists and is verified
          const nextGen = (typeof driver.dutyGeneration === 'number' && driver.dutyGeneration > 0)
            ? driver.dutyGeneration + 1
            : 1;

          const now = FieldValue.serverTimestamp();

          transaction.update(driverRef, {
            isOnDuty: false,
            workerReady: false,
            activeDutySessionId: null,
            dutyGeneration: nextGen,
            reapedAt: now,
            reapedReason: 'heartbeat_timeout_240s',
            updatedAt: now,
          });

          return true;
        });

        if (reaped) {
          reapedDriverIds.push(driverId);
          logger.info(`Reaped orphaned duty lease for driver ${driverId}`);
        }
      } catch (err) {
        logger.error(`Error processing driver ${driverId} in orphan duty sweep:`, err);
      }
    }

    return {
      scanned: candidates.length,
      reaped: reapedDriverIds.length,
      driverIds: reapedDriverIds,
    };
  }

  return { sweepOrphanedDutyLeases };
}

let defaultReaper;
function getDefaultOrphanDutyReaper() {
  if (!defaultReaper) {
    defaultReaper = createOrphanDutyReaper();
  }
  return defaultReaper;
}

const reconcileOrphanedDutyLeases = onSchedule({
  schedule: process.env.ORPHAN_DUTY_RECONCILE_SCHEDULE || process.env.DISPATCH_RECONCILE_SCHEDULE || 'every 1 minutes',
  timeZone: 'Asia/Kolkata',
}, async () => {
  const result = await getDefaultOrphanDutyReaper().sweepOrphanedDutyLeases();
  logger.info('Orphan duty sweep completed', result);
  return result;
});

module.exports = {
  createOrphanDutyReaper,
  getDefaultOrphanDutyReaper,
  reconcileOrphanedDutyLeases,
};
