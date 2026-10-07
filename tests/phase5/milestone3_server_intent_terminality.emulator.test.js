'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GeoPoint } = require('firebase-admin/firestore');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');

const {
  createPrepareDutyActivationManager,
  createPrepareDutyActivationCallable,
} = require('../../firebase/functions/src/duty/prepareDutyActivation');
const { createStartDutySessionManager } = require('../../firebase/functions/src/duty/startDutySession');
const { createCancelDutyActivationManager } = require('../../firebase/functions/src/duty/cancelDutyActivation');
const { createEndDutySessionManager } = require('../../firebase/functions/src/duty/endDutySession');
const { createReportLocationHeartbeatManager } = require('../../firebase/functions/src/duty/reportLocationHeartbeat');
const { createRecoverActiveJobSessionManager } = require('../../firebase/functions/src/duty/recoverActiveJobSession');

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

// Helper: Fully activate a duty session and return state
async function activateSession(db, uid, { gen = undefined, attemptSeq = undefined } = {}) {
  const prepMgr = createPrepareDutyActivationManager({ db });
  const startMgr = createStartDutySessionManager({ db });

  const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });
  const startRes = await startMgr.startDutySession({
    driverUid: uid,
    sessionId: prep.sessionId,
    initialLocation: { lat: 18.5204, lng: 73.8567 },
    lifecycleSeq: 1,
    generation: gen ?? prep.generation,
    attemptSeq: attemptSeq ?? prep.attemptSeq,
  });
  return { prep, startRes, sessionId: prep.sessionId, generation: prep.generation };
}

// Helper: Create an on-duty driver with active job, stale heartbeat (for recovery)
function createRecoverableDriver(uid, sessionId, gen = 1, lifecycleSeq = 1, jobId = 'job_123') {
  return createApprovedDriver(uid, {
    isOnDuty: true,
    workerReady: true,
    activeDutySessionId: sessionId,
    dutyGeneration: gen,
    lifecycleSeq: lifecycleSeq,
    activeJobId: jobId,
    locationUpdatedAt: FakeTimestamp.fromMillis(Date.now() - 120_000), // 120s ago — well past 60s silence
  });
}

test('MILESTONE 3 — Server Intent Terminality + Strict Validators + Recovery Epoch Fencing', async (t) => {

  // ============================================================
  // M3-A: Terminal Intent Immutability
  // ============================================================

  await t.test('M3-A-1: prepare cannot revive a cancelled intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a1';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    // Manually set intent to cancelled
    await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).set({
      ...((await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data()),
      status: 'cancelled',
    });

    // Attempt to prepare same session again
    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid, sessionId: prep.sessionId });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('cancelled'),
    );

    // Verify intent is still cancelled
    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data();
    assert.equal(intentDoc.status, 'cancelled');
  });

  await t.test('M3-A-2: prepare cannot revive an activated intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a2';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).set({
      ...((await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data()),
      status: 'activated',
    });

    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid, sessionId: prep.sessionId });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('activated'),
    );
  });

  await t.test('M3-A-3: prepare cannot revive a superseded intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a3';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).set({
      ...((await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data()),
      status: 'superseded',
    });

    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid, sessionId: prep.sessionId });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('superseded'),
    );
  });

  await t.test('M3-A-4: prepare cannot revive a recovered intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a4';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).set({
      ...((await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data()),
      status: 'recovered',
    });

    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid, sessionId: prep.sessionId });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('recovered'),
    );
  });

  await t.test('M3-A-5: stale start cannot consume a cancelled intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a5';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const cancelMgr = createCancelDutyActivationManager({ db });

    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    // Cancel the intent
    await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: prep.sessionId,
      generation: prep.generation,
      attemptSeq: prep.attemptSeq,
    });

    // Attempt to start
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep.generation,
          attemptSeq: prep.attemptSeq,
        });
      },
      (err) => err.code === 'cancelled',
    );

    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data();
    assert.equal(intentDoc.status, 'cancelled');
  });

  await t.test('M3-A-6: cancel against already-activated intent returns unaffected, does not mutate', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a6';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const { sessionId, generation } = await activateSession(db, uid);

    const endMgr = createEndDutySessionManager({ db });
    await endMgr.endDutySession({
      driverUid: uid,
      sessionId: sessionId,
      generation: generation,
      lifecycleSeq: 1,
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sessionId,
    });
    assert.equal(cancelRes.status, 'cancelled_unaffected');

    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sessionId}`).get()).data();
    assert.equal(intentDoc.status, 'activated', 'Activated intent MUST NOT be mutated by cancel');
  });

  await t.test('M3-A-7: cancel against already-recovered intent returns unaffected', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3a7';
    const sid = 'sess_recovered_a7';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 2 }));

    // Pre-seed a recovered intent
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'recovered',
      sourceSessionId: 'old_session',
      sourceGeneration: 1,
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
    });
    assert.equal(cancelRes.status, 'cancelled_unaffected');

    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentDoc.status, 'recovered', 'Recovered intent MUST NOT be mutated by cancel');
  });

  // ============================================================
  // M3-B: Exact Activation Consumption + Retry Truthfulness
  // ============================================================

  await t.test('M3-B-1: start missing generation fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b1';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          attemptSeq: prep.attemptSeq,
          // generation OMITTED
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('generation'),
    );
  });

  await t.test('M3-B-2: start wrong generation fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b2';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 999, // Wrong
          attemptSeq: prep.attemptSeq,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('Generation'),
    );
  });

  await t.test('M3-B-3: start missing attemptSeq fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b3';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep.generation,
          // attemptSeq OMITTED
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('attemptSeq'),
    );
  });

  await t.test('M3-B-4: start wrong attemptSeq fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b4';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep.generation,
          attemptSeq: 99, // Wrong
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('attempt'),
    );
  });

  await t.test('M3-B-5: start old attemptSeq after reprepare fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b5';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    const prep1 = await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: 'req_b5' });
    const prep2 = await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: 'req_b5' });
    assert.equal(prep2.attemptSeq, 2);

    // Use old attempt 1
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep2.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep2.generation,
          attemptSeq: 1, // Stale
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('mismatch'),
    );
  });

  await t.test('M3-B-8: activated retry with correct same epoch succeeds', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b8';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const { sessionId, generation } = await activateSession(db, uid);

    const startMgr = createStartDutySessionManager({ db });
    const retryRes = await startMgr.startDutySession({
      driverUid: uid,
      sessionId: sessionId,
      initialLocation: { lat: 18.5204, lng: 73.8567 },
      lifecycleSeq: 1,
      generation: generation,
      attemptSeq: 1,
    });
    assert.equal(retryRes.status, 'already_activated');
    assert.equal(retryRes.dutyGeneration, generation);
    assert.equal(retryRes.lifecycleSeq, 1);
  });

  await t.test('M3-B-9: activated retry with wrong generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b9';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const { sessionId, generation } = await activateSession(db, uid);

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: generation + 1, // Wrong generation
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('generation'),
    );
  });

  await t.test('M3-B-10: activated retry with wrong lifecycleSeq fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b10';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const { sessionId, generation } = await activateSession(db, uid);

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 999, // Wrong lifecycleSeq
          generation: generation,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('lifecycleSeq'),
    );
  });

  await t.test('M3-B-14: start with fractional generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b14';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: 'test_session',
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 1.5,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('generation'),
    );
  });

  await t.test('M3-B-15: start with negative generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b15';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: 'test_session',
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: -1,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('generation'),
    );
  });

  await t.test('M3-B-16: start with fractional attemptSeq fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b16';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep.generation,
          attemptSeq: 1.5,
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('attemptSeq'),
    );
  });

  await t.test('M3-B-17: start with string generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b17';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: 'test_session',
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 'two',
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'invalid-argument',
    );
  });

  await t.test('M3-B-18: start with null generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3b18';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: 'test_session',
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: null,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'invalid-argument',
    );
  });

  // ============================================================
  // M3-C: Terminal End/Cancel Truthfulness
  // ============================================================

  await t.test('M3-C-3: duplicate end returns already_off with no writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3c3';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1, isOnDuty: false }));

    const endMgr = createEndDutySessionManager({ db });
    const endRes = await endMgr.endDutySession({
      driverUid: uid,
      sessionId: 'old_session',
      generation: 1,
      lifecycleSeq: 1,
    });
    assert.equal(endRes.status, 'already_off');

    // No mutation occurred
    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.isOnDuty, false);
  });

  await t.test('M3-C-6: cancel against superseded intent returns cancelled_unaffected', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3c6';
    const sid = 'sess_superseded_c6';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 2 }));

    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'superseded',
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
    });
    assert.equal(cancelRes.status, 'cancelled_unaffected');

    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentDoc.status, 'superseded', 'Superseded intent MUST NOT be mutated');
  });

  // ============================================================
  // M3-D: Strict Authority Validators
  // ============================================================

  await t.test('M3-D-4: recovery missing activeDutySessionId fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d4';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d4'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          // activeDutySessionId OMITTED
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('activeDutySessionId'),
    );
  });

  await t.test('M3-D-5: recovery null dutyGeneration fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d5';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d5'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_d5',
          dutyGeneration: null,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('dutyGeneration'),
    );
  });

  await t.test('M3-D-6: recovery negative lifecycleSeq fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d6';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d6'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_d6',
          dutyGeneration: 1,
          lifecycleSeq: -1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('lifecycleSeq'),
    );
  });

  await t.test('M3-D-7: recovery fractional dutyGeneration fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d7';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d7'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_d7',
          dutyGeneration: 1.5,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('dutyGeneration'),
    );
  });

  await t.test('M3-D-8: recovery overflow integer fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d8';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d8'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_d8',
          dutyGeneration: Number.MAX_SAFE_INTEGER + 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument',
    );
  });

  await t.test('M3-D-9: recovery blank expectedActiveJobId fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d9';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d9'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_d9',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: '',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('expectedActiveJobId'),
    );
  });

  await t.test('M3-D-10: recovery whitespace-only activeDutySessionId fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3d10';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_d10'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: '   ',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'invalid-argument' && err.message.includes('activeDutySessionId'),
    );
  });

  // ============================================================
  // M3-E: Exact Recovery Source-Epoch Authority
  // ============================================================

  await t.test('M3-E-3: recovery with wrong sessionId fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3e3';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_real'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_wrong',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('session'),
    );
  });

  await t.test('M3-E-4: recovery with wrong generation fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3e4';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_e4'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_e4',
          dutyGeneration: 999,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('generation'),
    );
  });

  await t.test('M3-E-5: recovery with wrong lifecycleSeq fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3e5';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_e5'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_e5',
          dutyGeneration: 1,
          lifecycleSeq: 999,
          expectedActiveJobId: 'job_123',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('lifecycleSeq'),
    );
  });

  await t.test('M3-E-6: recovery with wrong activeJobId fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3e6';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_e6'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_e6',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'wrong_job',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('job'),
    );
  });

  await t.test('M3-E-9: successful recovery with exact source authority succeeds', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3e9';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_e9', 3, 2, 'job_abc'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const recRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_e9',
      dutyGeneration: 3,
      lifecycleSeq: 2,
      expectedActiveJobId: 'job_abc',
      clientRequestId: 'req_e9_unique',
    });

    assert.equal(recRes.status, 'recovered');
    assert.equal(recRes.dutyGeneration, 4);
    assert.equal(recRes.workerReady, false);
    assert.equal(recRes.lifecycleSeq, null);
    assert.equal(recRes.activeJobId, 'job_abc');
    assert.ok(recRes.sessionId, 'sessionId must be returned');
  });

  // ============================================================
  // M3-F: Delayed S1 Recovery Cannot Rotate S2
  // ============================================================

  await t.test('M3-F-1: delayed S1 recovery after S2 establishment fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3f1';
    // S1 is active at gen 1
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_s1', 1, 1, 'job_f1'));

    // Capture S1 recovery params
    const s1RecoveryParams = {
      driverUid: uid,
      activeDutySessionId: 'sess_s1',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_f1',
    };

    // Advance to S2: update driver to have new session and generation
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_s2', 2, 1, 'job_f1'));

    const recMgr = createRecoverActiveJobSessionManager({ db });

    // Delayed S1 recovery arrives — but driver is now at S2
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession(s1RecoveryParams);
      },
      (err) => err.code === 'failed-precondition',
    );

    // Verify S2 state is completely intact
    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.activeDutySessionId, 'sess_s2');
    assert.equal(driverDoc.dutyGeneration, 2);
    assert.equal(driverDoc.lifecycleSeq, 1);
    assert.equal(driverDoc.isOnDuty, true);
  });

  // ============================================================
  // M3-G: Recovery Intent Terminality + Idempotency
  // ============================================================

  await t.test('M3-G-1: duplicate recovery with same clientRequestId returns idempotent result', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3g1';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_g1', 1, 1, 'job_g1'));

    const recMgr = createRecoverActiveJobSessionManager({ db });

    // First recovery
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_g1',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_g1',
      clientRequestId: 'req_g1_idempotent',
    });
    assert.equal(rec1.status, 'recovered');

    // Second recovery with same clientRequestId and SAME source epoch — should be idempotent
    const rec2 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_g1', // SAME source epoch
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_g1',
      clientRequestId: 'req_g1_idempotent',
    });
    assert.equal(rec2.status, 'already_recovered');
    assert.equal(rec2.sessionId, rec1.sessionId);
    assert.equal(rec2.dutyGeneration, rec1.dutyGeneration);
  });

  await t.test('M3-G-7: collision with pre-existing terminal intent fails', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3g7';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_g7', 1, 1, 'job_g7'));

    // Pre-seed a terminal intent at the would-be recovery ID
    const clientReqId = 'req_g7_collision';
    const hash = crypto.createHash('sha256').update(clientReqId.trim()).digest('hex').slice(0, 16);
    const proposedId = `${uid}_rec_${hash}`;

    await db.doc(`drivers/${uid}/activation_intents/${proposedId}`).set({
      sessionId: proposedId,
      uid: uid,
      status: 'cancelled',
    });

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_g7',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_g7',
          clientRequestId: clientReqId,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('collision'),
    );

    // Original terminal intent unchanged
    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${proposedId}`).get()).data();
    assert.equal(intentDoc.status, 'cancelled');
  });

  // ============================================================
  // M3-H: Recovery Handoff Creates Valid New Epoch
  // ============================================================

  await t.test('M3-H-1: after recovery, driver.lifecycleSeq is null', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3h1';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_h1', 2, 5, 'job_h1'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_h1',
      dutyGeneration: 2,
      lifecycleSeq: 5,
      expectedActiveJobId: 'job_h1',
    });

    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.lifecycleSeq, null, 'lifecycleSeq MUST be null after recovery');
  });

  await t.test('M3-H-2: after recovery, driver.workerReady is false', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3h2';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_h2', 2, 5, 'job_h2'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_h2',
      dutyGeneration: 2,
      lifecycleSeq: 5,
      expectedActiveJobId: 'job_h2',
    });

    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.workerReady, false, 'workerReady MUST be false after recovery');
  });

  await t.test('M3-H-4: first heartbeat binds new native lifecycleSeq', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3h4';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_h4', 2, 5, 'job_h4'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const recRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_h4',
      dutyGeneration: 2,
      lifecycleSeq: 5,
      expectedActiveJobId: 'job_h4',
    });

    // Verify pre-binding state
    let driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.lifecycleSeq, null);
    assert.equal(driverDoc.workerReady, false);

    // First heartbeat from new worker binds lifecycleSeq
    const heartbeatMgr = createReportLocationHeartbeatManager({ db });
    const hbRes = await heartbeatMgr.reportLocationHeartbeat({
      driverUid: uid,
      sessionId: recRes.sessionId,
      generation: recRes.dutyGeneration,
      lifecycleSeq: 42, // New native worker's lifecycleSeq
      location: { lat: 18.5204, lng: 73.8567 },
    });
    assert.equal(hbRes.lifecycleBound, true, 'First heartbeat MUST bind lifecycleSeq');
    assert.equal(hbRes.workerReady, true, 'workerReady MUST be true after binding');
    assert.equal(hbRes.lifecycleSeq, 42);

    // Verify binding persisted
    driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.lifecycleSeq, 42, 'lifecycleSeq MUST be bound to 42');
    assert.equal(driverDoc.workerReady, true, 'workerReady MUST be true after binding');
  });

  await t.test('M3-H-5: subsequent heartbeat validates bound lifecycleSeq', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3h5';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_h5', 2, 5, 'job_h5'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const recRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_h5',
      dutyGeneration: 2,
      lifecycleSeq: 5,
      expectedActiveJobId: 'job_h5',
    });

    // Bind via first heartbeat
    const heartbeatMgr = createReportLocationHeartbeatManager({ db });
    await heartbeatMgr.reportLocationHeartbeat({
      driverUid: uid,
      sessionId: recRes.sessionId,
      generation: recRes.dutyGeneration,
      lifecycleSeq: 10,
      location: { lat: 18.5204, lng: 73.8567 },
    });

    // Second heartbeat with same seq succeeds
    const hb2 = await heartbeatMgr.reportLocationHeartbeat({
      driverUid: uid,
      sessionId: recRes.sessionId,
      generation: recRes.dutyGeneration,
      lifecycleSeq: 10,
      location: { lat: 18.5305, lng: 73.8668 },
    });
    assert.equal(hb2.success, true);

    // Heartbeat with WRONG seq fails
    await assert.rejects(
      async () => {
        await heartbeatMgr.reportLocationHeartbeat({
          driverUid: uid,
          sessionId: recRes.sessionId,
          generation: recRes.dutyGeneration,
          lifecycleSeq: 999,
          location: { lat: 18.5305, lng: 73.8668 },
        });
      },
      (err) => err.code === 'failed-precondition' && (err.message.includes('sequence') || err.message.includes('lifecycleSeq')),
    );
  });

  // ============================================================
  // M3-I: Stale Recovery Response Adoption Fence (server-side evidence)
  // ============================================================

  await t.test('M3-I-1: recovery response contains exact identity fields', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3i1';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_i1', 3, 2, 'job_i1'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const recRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_i1',
      dutyGeneration: 3,
      lifecycleSeq: 2,
      expectedActiveJobId: 'job_i1',
    });

    assert.ok(recRes.sessionId, 'Response MUST contain sessionId');
    assert.ok(typeof recRes.dutyGeneration === 'number', 'Response MUST contain dutyGeneration');
    assert.equal(recRes.workerReady, false, 'Response MUST contain workerReady = false');
    assert.equal(recRes.lifecycleSeq, null, 'Response MUST contain lifecycleSeq = null');
    assert.equal(recRes.activeJobId, 'job_i1', 'Response MUST contain activeJobId');
    assert.equal(recRes.status, 'recovered', 'Response MUST contain status = recovered');
  });

  await t.test('M3-I-2: after recovery+replacement, stale response identity mismatches current driver state', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_m3i2';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_i2', 3, 2, 'job_i2'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const staleRecRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_i2',
      dutyGeneration: 3,
      lifecycleSeq: 2,
      expectedActiveJobId: 'job_i2',
    });

    // Now advance to S2 (simulate another recovery or replacement)
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_s2_after', 5, 1, 'job_i2'));

    // Verify stale response identity does NOT match current driver state
    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.notEqual(driverDoc.activeDutySessionId, staleRecRes.sessionId, 'Stale response sessionId MUST NOT match current');
    assert.notEqual(driverDoc.dutyGeneration, staleRecRes.dutyGeneration, 'Stale response generation MUST NOT match current');
  });

  // ============================================================
  // Additional adversarial cases
  // ============================================================

  await t.test('Recovery cannot proceed when driver not on duty', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_off';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: false,
      activeJobId: 'job_off',
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'any',
          dutyGeneration: 0,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_off',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('not on duty'),
    );
  });

  await t.test('Recovery cannot proceed when no active job', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_nojob';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_nojob',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      activeJobId: null,
      locationUpdatedAt: FakeTimestamp.fromMillis(Date.now() - 120_000),
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_nojob',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'any_job',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('no active job'),
    );
  });

  await t.test('Recovery intent stores source epoch identity', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_src_epoch';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_src', 3, 7, 'job_src'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const recRes = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_src',
      dutyGeneration: 3,
      lifecycleSeq: 7,
      expectedActiveJobId: 'job_src',
      clientRequestId: 'req_src_epoch',
    });

    // Find and verify the recovery intent
    const hash = crypto.createHash('sha256').update('req_src_epoch').digest('hex').slice(0, 16);
    const intentId = `${uid}_rec_${hash}`;
    const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${intentId}`).get()).data();

    assert.equal(intentDoc.status, 'recovered');
    assert.equal(intentDoc.sourceSessionId, 'sess_src');
    assert.equal(intentDoc.sourceGeneration, 3);
    assert.equal(intentDoc.sourceLifecycleSeq, 7);
    assert.equal(intentDoc.jobId, 'job_src');
    assert.equal(intentDoc.generation, 4);
  });

  await t.test('Start on recovered intent fails (terminal)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_start_rec';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    const prep = await prepMgr.prepareDutyActivation({ driverUid: uid });

    // Manually set intent to recovered
    await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).set({
      ...((await db.doc(`drivers/${uid}/activation_intents/${prep.sessionId}`).get()).data()),
      status: 'recovered',
    });

    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: prep.sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prep.generation,
          attemptSeq: prep.attemptSeq,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('recovered'),
    );
  });

  await t.test('Recovery with recent heartbeat fails silence threshold', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_fresh';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_fresh', 1, 1, 'job_fresh'));

    // Override to fresh heartbeat (10s ago, well within 60s)
    await db.collection('drivers').doc(uid).update({
      locationUpdatedAt: FakeTimestamp.fromMillis(Date.now() - 10_000),
    });

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_fresh',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_fresh',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('silence'),
    );
  });

  // ============================================================
  // MANDATORY INDEPENDENT-FAILURE REGRESSION TESTS
  // ============================================================

  await t.test('IR-1: Active cancel against activated intent deactivates driver but preserves terminal intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir1';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const { sessionId, generation } = await activateSession(db, uid);

    const intentBefore = (await db.doc(`drivers/${uid}/activation_intents/${sessionId}`).get()).data();
    assert.equal(intentBefore.status, 'activated');

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sessionId,
      generation: 2,
      lifecycleSeq: 1,
    });
    assert.equal(cancelRes.status, 'deactivated');
    assert.equal(cancelRes.dutyState, 'off');

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false);
    assert.equal(driverAfter.activeDutySessionId, null);
    assert.equal(driverAfter.dutyGeneration, 3);

    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sessionId}`).get()).data();
    assert.equal(intentAfter.status, 'activated', 'Terminal intent status MUST remain activated');
    assert.deepEqual(intentAfter.activatedAt, intentBefore.activatedAt, 'activatedAt timestamp must be preserved');
    assert.equal(intentAfter.cancelledAt, undefined, 'cancelledAt must NOT be written to activated intent');
  });

  await t.test('IR-2: Active cancel against superseded intent deactivates driver but preserves superseded intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir2';
    const sid = 'sess_ir2_sup';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: sid,
      dutyGeneration: 2,
      lifecycleSeq: 1,
    }));

    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'superseded',
      supersededAt: FakeTimestamp.fromMillis(123456789),
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
      generation: 2,
      lifecycleSeq: 1,
    });
    assert.equal(cancelRes.status, 'deactivated');

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false);

    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'superseded', 'Terminal intent status MUST remain superseded');
    assert.equal(intentAfter.cancelledAt, undefined);
  });

  await t.test('IR-3: Active cancel against recovered intent deactivates driver but preserves recovered intent', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir3';
    const sid = 'sess_ir3_rec';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: sid,
      dutyGeneration: 3,
      lifecycleSeq: 1,
    }));

    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'recovered',
      sourceSessionId: 'sess_prev',
      sourceGeneration: 2,
      recoveredAt: FakeTimestamp.fromMillis(123456789),
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const cancelRes = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
      generation: 3,
      lifecycleSeq: 1,
    });
    assert.equal(cancelRes.status, 'deactivated');

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false);

    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'recovered', 'Terminal intent status MUST remain recovered');
    assert.equal(intentAfter.cancelledAt, undefined);
  });

  await t.test('IR-4: Start with stored generation absent fails closed with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir4';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const sid = 'sess_ir4';
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'pending',
      // generation ABSENT
      attemptSeq: 1,
      expiresAt: FakeTimestamp.fromMillis(Date.now() + 300_000),
    });

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: sid,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 1,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('generation'),
    );

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false, 'Driver MUST remain OFF');
    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'pending', 'Intent MUST remain pending');
  });

  await t.test('IR-5: Start with stored attemptSeq absent fails closed with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir5';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const sid = 'sess_ir5';
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'pending',
      generation: 1,
      // attemptSeq ABSENT
      expiresAt: FakeTimestamp.fromMillis(Date.now() + 300_000),
    });

    const startMgr = createStartDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: sid,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: 1,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('attemptSeq'),
    );

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false, 'Driver MUST remain OFF');
    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'pending', 'Intent MUST remain pending');
  });

  await t.test('IR-6: Explicit malformed prepare sessionId rejects with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir6';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });

    for (const badSessionId of [null, '', '   ', ' untrimmed ', 123, true, {}]) {
      await assert.rejects(
        async () => {
          await prepMgr.prepareDutyActivation({ driverUid: uid, sessionId: badSessionId });
        },
        (err) => err.code === 'invalid-argument',
        `Should reject bad sessionId: ${JSON.stringify(badSessionId)}`,
      );
    }

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0, 'Zero intents must be created on rejection');
  });

  await t.test('IR-7: Explicit malformed prepare clientRequestId rejects with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir7';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 1 }));

    const prepMgr = createPrepareDutyActivationManager({ db });

    for (const badCrid of [null, '', '   ', ' untrimmed ', 123, true, {}]) {
      await assert.rejects(
        async () => {
          await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: badCrid });
        },
        (err) => err.code === 'invalid-argument',
        `Should reject bad clientRequestId: ${JSON.stringify(badCrid)}`,
      );
    }

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0, 'Zero intents must be created on rejection');
  });

  await t.test('IR-8: Pending cancel with missing stored generation fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir8';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const sid = 'sess_ir8';
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'pending',
      // generation ABSENT
      attemptSeq: 1,
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const res = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
      generation: 1,
      attemptSeq: 1,
    });
    assert.equal(res.status, 'cancelled_unaffected', 'Must return cancelled_unaffected');

    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'pending', 'Intent MUST remain pending');
  });

  await t.test('IR-9: Pending cancel with missing stored attemptSeq fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir9';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const sid = 'sess_ir9';
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'pending',
      generation: 1,
      // attemptSeq ABSENT
    });

    const cancelMgr = createCancelDutyActivationManager({ db });
    const res = await cancelMgr.cancelDutyActivation({
      driverUid: uid,
      sessionId: sid,
      generation: 1,
      attemptSeq: 1,
    });
    assert.equal(res.status, 'cancelled_unaffected', 'Must return cancelled_unaffected');

    const intentAfter = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
    assert.equal(intentAfter.status, 'pending', 'Intent MUST remain pending');
  });

  await t.test('IR-10: MAX_SAFE_INTEGER generation increment rejection across all mutation paths', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir10';

    // 1. prepareDutyActivation
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: Number.MAX_SAFE_INTEGER }));
    const prepMgr = createPrepareDutyActivationManager({ db });
    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('maximum safe integer'),
    );

    // 2. startDutySession
    const startMgr = createStartDutySessionManager({ db });
    const sid = 'sess_ir10_start';
    await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
      sessionId: sid,
      uid: uid,
      status: 'pending',
      generation: Number.MAX_SAFE_INTEGER,
      attemptSeq: 1,
      expiresAt: FakeTimestamp.fromMillis(Date.now() + 300_000),
    });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId: sid,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: Number.MAX_SAFE_INTEGER,
          attemptSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('maximum safe integer'),
    );

    // 3. endDutySession
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: 'sess_active',
      dutyGeneration: Number.MAX_SAFE_INTEGER,
      lifecycleSeq: 1,
    }));
    const endMgr = createEndDutySessionManager({ db });
    await assert.rejects(
      async () => {
        await endMgr.endDutySession({
          driverUid: uid,
          sessionId: 'sess_active',
          generation: Number.MAX_SAFE_INTEGER,
          lifecycleSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('maximum safe integer'),
    );

    // 4. cancelDutyActivation active owner
    const cancelMgr = createCancelDutyActivationManager({ db });
    await assert.rejects(
      async () => {
        await cancelMgr.cancelDutyActivation({
          driverUid: uid,
          sessionId: 'sess_active',
          generation: Number.MAX_SAFE_INTEGER,
          lifecycleSeq: 1,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('maximum safe integer'),
    );

    // 5. recoverActiveJobSession
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_rec', Number.MAX_SAFE_INTEGER, 1, 'job_rec'));
    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_rec',
          dutyGeneration: Number.MAX_SAFE_INTEGER,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_rec',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('maximum safe integer'),
    );
  });

  await t.test('IR-11: Malformed persisted recovery session ID (" S1 ") fails closed', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir11';
    // Persisted activeDutySessionId has untrimmed whitespace
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, ' S1 ', 1, 1, 'job_ir11'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'S1',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_ir11',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('malformed'),
    );

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.activeDutySessionId, ' S1 ', 'Driver doc must not be mutated');
    assert.equal(driverAfter.dutyGeneration, 1, 'Generation must not increment');
  });

  await t.test('IR-12: Explicit malformed recovery clientRequestId rejects with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir12';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_ir12', 1, 1, 'job_ir12'));

    const recMgr = createRecoverActiveJobSessionManager({ db });

    for (const badCrid of [null, '', '   ', ' untrimmed ', 123, true, {}]) {
      await assert.rejects(
        async () => {
          await recMgr.recoverActiveJobSession({
            driverUid: uid,
            activeDutySessionId: 'sess_ir12',
            dutyGeneration: 1,
            lifecycleSeq: 1,
            expectedActiveJobId: 'job_ir12',
            clientRequestId: badCrid,
          });
        },
        (err) => err.code === 'invalid-argument',
        `Should reject bad clientRequestId: ${JSON.stringify(badCrid)}`,
      );
    }

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.activeDutySessionId, 'sess_ir12');
    assert.equal(driverAfter.dutyGeneration, 1);
  });

  await t.test('IR-13: Recovery ID reuse after active job change fails closed with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir13';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_ir13', 1, 1, 'job_initial'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const clientReqId = 'req_ir13_job_change';

    // First recovery succeeds
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_ir13',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_initial',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Active job changes from job_initial to job_new
    await db.collection('drivers').doc(uid).update({
      activeJobId: 'job_new',
    });

    // Replay with same recovery request ID must reject
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_ir13',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_initial',
          clientRequestId: clientReqId,
        });
      },
      (err) => err.code === 'failed-precondition',
    );

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.activeJobId, 'job_new');
    assert.equal(driverAfter.dutyGeneration, 2);
  });

  await t.test('IR-14: Recovery ID reuse after result generation advances fails closed with zero writes', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_ir14';
    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_ir14', 1, 1, 'job_ir14'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const clientReqId = 'req_ir14_gen_change';

    // First recovery succeeds -> dutyGeneration becomes 2
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_ir14',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_ir14',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Driver generation advances to 3 (e.g. through further activity)
    await db.collection('drivers').doc(uid).update({
      dutyGeneration: 3,
    });

    // Replay with same recovery request ID must reject
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_ir14',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_ir14',
          clientRequestId: clientReqId,
        });
      },
      (err) => err.code === 'failed-precondition',
    );

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.dutyGeneration, 3);
  });

  // =========================================================================
  // M3-D-1 Public Callable Wrapper Tests (D1 - D14)
  // =========================================================================

  await t.test('D1: public prepare with both selectors omitted succeeds without ReferenceError', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d1';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    const res = await callable.run({ auth: { uid }, data: {} });
    assert.ok(res.sessionId, 'Session ID must be generated');
    assert.equal(res.generation, 1, 'Generation must be 1');
    assert.equal(res.attemptSeq, 1, 'AttemptSeq must be 1');
    assert.equal(res.idempotent, false);
    assert.ok(res.expiresAtMs > Date.now());

    const intentSnap = await db.doc(`drivers/${uid}/activation_intents/${res.sessionId}`).get();
    assert.ok(intentSnap.exists, 'Intent document must exist');
    const intent = intentSnap.data();
    assert.equal(intent.status, 'pending');
    assert.equal(intent.generation, 1);
    assert.equal(intent.attemptSeq, 1);
    assert.equal(intent.uid, uid);

    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.isOnDuty, false, 'Driver must remain off duty');
    assert.equal(driverAfter.dutyGeneration, 0, 'Driver dutyGeneration must not change on prepare');
  });

  await t.test('D2: public prepare with sessionId = null rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d2';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { sessionId: null } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('sessionId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0, 'Zero intents must be created on rejection');
    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.dutyGeneration, 0);
  });

  await t.test('D3: public prepare with sessionId wrong type rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d3';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    for (const badVal of [false, true, 123, {}, ['sess']]) {
      await assert.rejects(
        async () => callable.run({ auth: { uid }, data: { sessionId: badVal } }),
        (err) => err.code === 'invalid-argument' && err.message.includes('sessionId'),
      );
    }

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0, 'Zero intents must be created on rejection');
    const driverAfter = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverAfter.dutyGeneration, 0);
  });

  await t.test('D4: public prepare with sessionId blank rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d4';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { sessionId: '' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('sessionId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D5: public prepare with sessionId whitespace rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d5';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { sessionId: '   ' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('sessionId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D6: public prepare with padded sessionId (" S1 ") rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d6';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { sessionId: ' S1 ' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('sessionId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D7: public prepare with clientRequestId = null rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d7';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { clientRequestId: null } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('clientRequestId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D8: public prepare with clientRequestId wrong type rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d8';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    for (const badVal of [false, true, 456, {}, ['req']]) {
      await assert.rejects(
        async () => callable.run({ auth: { uid }, data: { clientRequestId: badVal } }),
        (err) => err.code === 'invalid-argument' && err.message.includes('clientRequestId'),
      );
    }

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D9: public prepare with clientRequestId blank rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d9';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { clientRequestId: '' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('clientRequestId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D10: public prepare with clientRequestId whitespace rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d10';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { clientRequestId: '   ' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('clientRequestId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D11: public prepare with padded clientRequestId (" REQ1 ") rejects with invalid-argument (zero mutation)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d11';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    await assert.rejects(
      async () => callable.run({ auth: { uid }, data: { clientRequestId: ' REQ1 ' } }),
      (err) => err.code === 'invalid-argument' && err.message.includes('clientRequestId'),
    );

    const intents = await db.collection(`drivers/${uid}/activation_intents`).get();
    assert.equal(intents.size, 0);
  });

  await t.test('D12: public prepare with valid sessionId succeeds with exact sessionId', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d12';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    const res = await callable.run({ auth: { uid }, data: { sessionId: 'sess_custom_valid_d12' } });
    assert.equal(res.sessionId, 'sess_custom_valid_d12');
    assert.equal(res.generation, 1);
    assert.equal(res.attemptSeq, 1);

    const intentSnap = await db.doc(`drivers/${uid}/activation_intents/sess_custom_valid_d12`).get();
    assert.ok(intentSnap.exists);
    assert.equal(intentSnap.data().status, 'pending');
  });

  await t.test('D13: public prepare with valid clientRequestId derives session and supports idempotent replay', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_d13';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    const res1 = await callable.run({ auth: { uid }, data: { clientRequestId: 'req_valid_d13' } });
    assert.ok(res1.sessionId);
    assert.equal(res1.generation, 1);
    assert.equal(res1.attemptSeq, 1);
    assert.equal(res1.idempotent, false);

    // Idempotent retry with same clientRequestId
    const res2 = await callable.run({ auth: { uid }, data: { clientRequestId: 'req_valid_d13' } });
    assert.equal(res2.sessionId, res1.sessionId);
    assert.equal(res2.generation, 1);
    assert.equal(res2.attemptSeq, 2);
    assert.equal(res2.idempotent, true);
  });

  await t.test('D14: public prepare strictly uses request.auth.uid and ignores caller data.driverUid spoofing', async () => {
    const db = new FakeFirestore();
    const victimUid = 'driver_victim';
    const attackerUid = 'driver_attacker';

    await db.collection('drivers').doc(victimUid).set(createApprovedDriver(victimUid, { dutyGeneration: 0 }));
    await db.collection('drivers').doc(attackerUid).set(createApprovedDriver(attackerUid, { dutyGeneration: 0 }));

    const callable = createPrepareDutyActivationCallable({
      manager: createPrepareDutyActivationManager({ db }),
    });

    // Attacker authenticated, but specifies victimUid in request.data
    const res = await callable.run({
      auth: { uid: attackerUid },
      data: { driverUid: victimUid },
    });

    // Intent must be created under attackerUid, NEVER victimUid
    const attackerIntents = await db.collection(`drivers/${attackerUid}/activation_intents`).get();
    assert.equal(attackerIntents.size, 1);
    assert.equal(attackerIntents.docs[0].id, res.sessionId);

    const victimIntents = await db.collection(`drivers/${victimUid}/activation_intents`).get();
    assert.equal(victimIntents.size, 0, 'Victim driver must have ZERO intents created');
  });
});
