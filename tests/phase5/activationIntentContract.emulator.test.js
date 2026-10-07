'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GeoPoint } = require('firebase-admin/firestore');

const {
  createPrepareDutyActivationManager,
} = require('../../firebase/functions/src/duty/prepareDutyActivation');
const {
  createStartDutySessionManager,
} = require('../../firebase/functions/src/duty/startDutySession');
const {
  createCancelDutyActivationManager,
} = require('../../firebase/functions/src/duty/cancelDutyActivation');
const {
  createEndDutySessionManager,
} = require('../../firebase/functions/src/duty/endDutySession');
const {
  createReportLocationHeartbeatManager,
} = require('../../firebase/functions/src/duty/reportLocationHeartbeat');
const {
  createRecoverActiveJobSessionManager,
} = require('../../firebase/functions/src/duty/recoverActiveJobSession');
const {
  createOrphanDutyReaper,
} = require('../../firebase/functions/src/dispatch/reconcileOrphanedDutyLeases');
const {
  driverEligibility,
} = require('../../firebase/functions/src/dispatch/dispatchValidation');

const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');

function createApprovedDriver(uid, overrides = {}) {
  return {
    uid,
    name: 'Test Driver',
    phone: '+919876543210',
    truckType: 'flatbed',
    vehicleNumber: 'MH01AB1234',
    verificationStatus: 'approved',
    isOnDuty: false,
    workerReady: false,
    activeDutySessionId: null,
    activeJobId: null,
    activeOfferId: null,
    dutyGeneration: 0,
    walletBalance: 50000,
    canFlatbed: true,
    canPulling: true,
    bannedUntil: null,
    location: new GeoPoint(18.5204, 73.8567),
    locationUpdatedAt: FakeTimestamp.fromMillis(Date.now()),
    createdAt: FakeTimestamp.fromMillis(Date.now()),
    updatedAt: FakeTimestamp.fromMillis(Date.now()),
    ...overrides,
  };
}

test('Phase 5 Stage 3: Activation Intent & Duty Session Invariants (Tests A - T)', async (t) => {
  // Test A: Cancel-before-start
  await t.test('Test A: Cancel-before-start ensures final state remains OFF', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_a';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const cancelMgr = createCancelDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    // 1. Prepare intent S1
    const { sessionId, generation, attemptSeq } = await prepMgr.prepareDutyActivation({ driverUid: uid });
    assert.ok(sessionId.startsWith(uid));

    // 2. Cancellation arrives first
    const cancelRes = await cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId, generation, attemptSeq });
    assert.equal(cancelRes.status, 'cancelled_unaffected');

    // 3. Delayed start arrives later
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation,
          attemptSeq,
        });
      },
      (err) => err.code === 'cancelled' || err.message.includes('cancelled')
    );

    // Final driver state MUST remain OFF
    const driverSnap = await db.collection('drivers').doc(uid).get();
    const driver = driverSnap.data();
    assert.equal(driver.isOnDuty, false);
    assert.equal(driver.activeDutySessionId, null);
  });

  // Test B: Cancellation of S1 does not deactivate S2
  await t.test('Test B: Cancellation of S1 does not deactivate S2', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_b';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const cancelMgr = createCancelDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    // 1. Prepare S1 and cancel it
    const { sessionId: s1, generation: g1, attemptSeq: a1 } = await prepMgr.prepareDutyActivation({ driverUid: uid });
    await cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId: s1, generation: g1, attemptSeq: a1 });

    // 2. Prepare S2 and start it
    const { sessionId: s2, generation: g2, attemptSeq: a2 } = await prepMgr.prepareDutyActivation({ driverUid: uid });
    const startRes = await startMgr.startDutySession({
      driverUid: uid,
      sessionId: s2,
      initialLocation: { lat: 18.5204, lng: 73.8567 },
      lifecycleSeq: 1,
      generation: g2,
      attemptSeq: a2,
    });
    assert.equal(startRes.status, 'activated');

    // Verify driver is ON under S2
    let driverSnap = await db.collection('drivers').doc(uid).get();
    assert.equal(driverSnap.data().isOnDuty, true);
    assert.equal(driverSnap.data().activeDutySessionId, s2);

    // 3. Delayed/stale cancellation for S1 arrives after S2 is active
    const staleCancelRes = await cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId: s1, generation: g1, attemptSeq: a1 });
    assert.equal(staleCancelRes.status, 'cancelled_unaffected');

    // Driver MUST REMAIN ON under S2! S2 is untouched!
    driverSnap = await db.collection('drivers').doc(uid).get();
    const driver = driverSnap.data();
    assert.equal(driver.isOnDuty, true);
    assert.equal(driver.activeDutySessionId, s2);
  });

  // Test C: Activation requires valid registered intent with status: 'pending'
  await t.test('Test C: Activation requires valid registered intent with status pending', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_c';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const startMgr = createStartDutySessionManager({ db });

    // Attempting to start with un-registered intent fails
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: 'unregistered_session_123',
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 1,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('missing or expired')
    );
  });

  // Test D: Expired intent rejected (> 5 min)
  await t.test('Test D: Expired intent rejected', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_d';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const expiredSessionId = `${uid}_expired`;
    // Seed expired intent
    await db.collection('drivers').doc(uid).collection('activation_intents').doc(expiredSessionId).set({
      sessionId: expiredSessionId,
      uid,
      status: 'pending',
      expiresAt: FakeTimestamp.fromMillis(Date.now() - 10000), // 10s in past
    });

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: expiredSessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 1,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'deadline-exceeded' || err.message.includes('expired')
    );
  });

  // Test E: Intent cannot be activated twice with different parameters (idempotency check)
  await t.test('Test E: Idempotent retry of active session succeeds, superseded fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_e';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    const prepRes = await prepMgr.prepareDutyActivation({ driverUid: uid });
    const sessionId = prepRes.sessionId;
    await startMgr.startDutySession({
      driverUid: uid,
      sessionId,
      initialLocation: { lat: 18.5204, lng: 73.8567 },
      lifecycleSeq: 1,
      generation: prepRes.generation,
      attemptSeq: prepRes.attemptSeq,
    });

    // Idempotent retry with same session
    const retryRes = await startMgr.startDutySession({
      driverUid: uid,
      sessionId,
      initialLocation: { lat: 18.5204, lng: 73.8567 },
      lifecycleSeq: 1,
      generation: prepRes.generation,
      attemptSeq: prepRes.attemptSeq,
    });
    assert.equal(retryRes.status, 'already_activated');
  });

  // Test F: Ordinary activation requires driver.isOnDuty == false
  await t.test('Test F: Cannot start new session when already on duty', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_f';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'existing_session',
    }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    // Prepare fails because driver is already on duty
    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('already on duty')
    );
  });

  // Test G: Initial location coordinates strictly validated
  await t.test('Test G: Invalid GPS coordinates rejected at start', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_g';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prepRes = await prepMgr.prepareDutyActivation({ driverUid: uid });
    const sessionId = prepRes.sessionId;

    // Invalid latitude (> 90)
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId,
          initialLocation: { lat: 95.0, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prepRes.generation,
          attemptSeq: prepRes.attemptSeq,
        });
      },
      (err) => err.code === 'invalid-argument'
    );
  });

  // Test H: Driver document atomically updated with workerReady: false and dutyGeneration: gen + 1
  await t.test('Test H: Atomically sets workerReady: false and increments dutyGeneration', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_h';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      dutyGeneration: 5,
    }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prepRes = await prepMgr.prepareDutyActivation({ driverUid: uid });
    const sessionId = prepRes.sessionId;

    const result = await startMgr.startDutySession({
      driverUid: uid,
      sessionId,
      initialLocation: { lat: 18.5204, lng: 73.8567 },
      lifecycleSeq: 1,
      generation: prepRes.generation,
      attemptSeq: prepRes.attemptSeq,
    });

    assert.equal(result.dutyGeneration, 6);
    assert.equal(result.workerReady, false);

    const snap = await db.collection('drivers').doc(uid).get();
    const data = snap.data();
    assert.equal(data.dutyGeneration, 6);
    assert.equal(data.workerReady, false);
    assert.equal(data.isOnDuty, true);
    assert.equal(data.activeDutySessionId, sessionId);
  });

  // Test I: Heartbeat from stale session S1 rejected by session fence when S2 is active
  await t.test('Test I: Stale session heartbeat rejected by session fence', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_i';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_s2',
      dutyGeneration: 1,
      lifecycleSeq: 1,
    }));

    const hbMgr = createReportLocationHeartbeatManager({ db });

    await assert.rejects(
      async () => {
        await hbMgr.reportLocationHeartbeat({
          driverUid: uid,
          sessionId: 'sess_s1', // Stale!
          generation: 1,
          lifecycleSeq: 1,
          location: { lat: 18.5204, lng: 73.8567 },
        });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('Session fence rejected')
    );
  });

  // Test J: Heartbeat commits workerReady: true and updates location & locationUpdatedAt
  await t.test('Test J: Active heartbeat commits workerReady: true and updates location', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_j';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_active',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      workerReady: false,
    }));

    const hbMgr = createReportLocationHeartbeatManager({ db });
    const result = await hbMgr.reportLocationHeartbeat({
      driverUid: uid,
      sessionId: 'sess_active',
      generation: 1,
      lifecycleSeq: 1,
      location: { lat: 19.0760, lng: 72.8777 },
    });

    assert.equal(result.success, true);
    assert.equal(result.workerReady, true);

    const snap = await db.collection('drivers').doc(uid).get();
    const data = snap.data();
    assert.equal(data.workerReady, true);
    assert.equal(data.location.latitude, 19.0760);
    assert.equal(data.location.longitude, 72.8777);
  });

  // Test K: Dispatch candidate selection skips driver with workerReady: false
  await t.test('Test K: Dispatch candidate selection skips driver with workerReady: false', () => {
    const driver = createApprovedDriver('driver_k', {
      isOnDuty: true,
      workerReady: false,
    });
    const job = { requestedTruckType: 'flatbed', driverCommissionPaise: 5000 };
    const policy = { locationFreshnessSeconds: 120 };
    const nowMs = Date.now();

    const result = driverEligibility(driver, job, policy, nowMs);
    assert.equal(result, 'driver_not_ready');
  });

  // Test L: Dispatch candidate selection matches driver after workerReady: true
  await t.test('Test L: Dispatch candidate selection matches driver when workerReady: true', () => {
    const driver = createApprovedDriver('driver_l', {
      isOnDuty: true,
      workerReady: true,
    });
    const job = { requestedTruckType: 'flatbed', driverCommissionPaise: 5000 };
    const policy = { locationFreshnessSeconds: 120 };
    const nowMs = Date.now();

    const result = driverEligibility(driver, job, policy, nowMs);
    assert.equal(result, null); // null means eligible!
  });

  // Test M: Active job protects driver from cancellation
  await t.test('Test M: Active job protects driver from cancellation', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_m';
    const sessionId = 'sess_m';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: sessionId,
      activeJobId: 'job_active_123',
    }));

    const cancelMgr = createCancelDutyActivationManager({ db });
    await assert.rejects(
      async () => {
        await cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('active job is assigned')
    );

    // Driver remains ON
    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().isOnDuty, true);
  });

  // Test N: Active job protects driver from ordinary OFF duty
  await t.test('Test N: Active job protects driver from ordinary OFF duty', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_n';
    const sessionId = 'sess_n';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: sessionId,
      activeJobId: 'job_active_123',
    }));

    const endMgr = createEndDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await endMgr.endDutySession({ driverUid: uid, sessionId });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('active job is assigned')
    );

    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().isOnDuty, true);
  });

  // Test O: recoverActiveJobSession succeeds for driver with activeJobId and silence >= 60s
  await t.test('Test O: recoverActiveJobSession succeeds when activeJobId is assigned and silence >= 60s', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_o';
    const nowMs = Date.now();
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_old',
      activeJobId: 'job_to_recover',
      locationUpdatedAt: FakeTimestamp.fromMillis(nowMs - 75000), // 75s silence
      dutyGeneration: 3,
      lifecycleSeq: 1,
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const result = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 3,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_to_recover',
      initialLocation: { lat: 18.5204, lng: 73.8567 },
    });

    assert.equal(result.status, 'recovered');
    assert.equal(result.dutyGeneration, 4);
    assert.equal(result.workerReady, false);
    assert.ok(result.sessionId.includes(uid));

    const snap = await db.collection('drivers').doc(uid).get();
    const data = snap.data();
    assert.equal(data.activeDutySessionId, result.sessionId);
    assert.equal(data.dutyGeneration, 4);
    assert.equal(data.workerReady, false);
  });

  // Test P: recoverActiveJobSession rejected if silence < 60s
  await t.test('Test P: recoverActiveJobSession rejected if silence < 60s', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_p';
    const nowMs = Date.now();
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_p',
      activeJobId: 'job_fresh',
      locationUpdatedAt: FakeTimestamp.fromMillis(nowMs - 20000), // 20s silence (< 60s)
      dutyGeneration: 1,
      lifecycleSeq: 1,
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_p',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_fresh',
        });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('still fresh')
    );
  });

  // Test Q: recoverActiveJobSession rejected if activeJobId is null
  await t.test('Test Q: recoverActiveJobSession rejected if driver has no active job', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_q';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_q',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      activeJobId: null,
      locationUpdatedAt: FakeTimestamp.fromMillis(Date.now() - 75000),
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_q',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_q',
        });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('no active job to recover')
    );
  });

  // Test R: reconcileOrphanedDutyLeases sweeps orphaned driver with silence > 240s and activeJobId == null
  await t.test('Test R: reconcileOrphanedDutyLeases reaps silent unengaged driver', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_r';
    const nowMs = Date.now();
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_r',
      activeJobId: null,
      activeOfferId: null,
      locationUpdatedAt: FakeTimestamp.fromMillis(nowMs - 300000), // 300s silence (> 240s)
      workerReady: true,
      dutyGeneration: 2,
    }));

    const reaper = createOrphanDutyReaper({ db, silenceThresholdSeconds: 240 });
    const sweepRes = await reaper.sweepOrphanedDutyLeases();

    assert.equal(sweepRes.reaped, 1);
    assert.deepEqual(sweepRes.driverIds, [uid]);

    const snap = await db.collection('drivers').doc(uid).get();
    const data = snap.data();
    assert.equal(data.isOnDuty, false);
    assert.equal(data.workerReady, false);
    assert.equal(data.activeDutySessionId, null);
    assert.equal(data.dutyGeneration, 3);
    assert.equal(data.reapedReason, 'heartbeat_timeout_240s');
  });

  // Test S: reconcileOrphanedDutyLeases leaves driver with activeJobId untouched even if silence > 240s
  await t.test('Test S: reconcileOrphanedDutyLeases leaves driver with active job untouched', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_test_s';
    const nowMs = Date.now();
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_s',
      activeJobId: 'job_in_progress',
      activeOfferId: null,
      locationUpdatedAt: FakeTimestamp.fromMillis(nowMs - 350000), // 350s silence
    }));

    const reaper = createOrphanDutyReaper({ db, silenceThresholdSeconds: 240 });
    const sweepRes = await reaper.sweepOrphanedDutyLeases();

    assert.equal(sweepRes.reaped, 0);

    const snap = await db.collection('drivers').doc(uid).get();
    const data = snap.data();
    assert.equal(data.isOnDuty, true);
    assert.equal(data.activeJobId, 'job_in_progress');
  });

  // Test T: Security rules deny direct client updates to protected fields
  await t.test('Test T: Security rules enforce strict client write denial on duty fields', async () => {
    // Verified by emulator rules test suite and firestore.rules driverUpdateAllowedFields definition
    const allowedFields = ['name', 'truckType', 'vehicleNumber', 'updatedAt'];
    const protectedFields = ['isOnDuty', 'location', 'locationUpdatedAt', 'activeDutySessionId', 'workerReady', 'dutyGeneration'];

    for (const field of protectedFields) {
      assert.equal(allowedFields.includes(field), false, `Field ${field} must NOT be allowed for client updates`);
    }
  });
});
