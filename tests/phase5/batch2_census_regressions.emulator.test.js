'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GeoPoint } = require('firebase-admin/firestore');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');

const { createPrepareDutyActivationManager } = require('../../firebase/functions/src/duty/prepareDutyActivation');
const { createCancelDutyActivationManager } = require('../../firebase/functions/src/duty/cancelDutyActivation');
const { createEndDutySessionManager } = require('../../firebase/functions/src/duty/endDutySession');
const { createReportLocationHeartbeatManager } = require('../../firebase/functions/src/duty/reportLocationHeartbeat');

function createApprovedDriver(uid, overrides = {}) {
  return {
    uid,
    name: 'Census Driver',
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

test('Batch 2: Groups F, G, H (F11–F16) Backend Authority Validation Regressions', async (t) => {
  // ============================================================
  // Group F: F11 — Pending cancellation authority binding (Cases 45–52)
  // ============================================================
  await t.test('F11: pending CANCEL with corrupt/mismatched stored uid or sessionId preserves intent untouched', async () => {
    const invalidStoredIdentities = [
      { name: 'uid missing', data: { sessionId: 'census_S', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'uid null', data: { uid: null, sessionId: 'census_S', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'uid wrong', data: { uid: 'OTHER', sessionId: 'census_S', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'uid padded', data: { uid: ' census_A ', sessionId: 'census_S', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'sessionId missing', data: { uid: 'census_A', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'sessionId null', data: { uid: 'census_A', sessionId: null, generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'sessionId wrong', data: { uid: 'census_A', sessionId: 'OTHER', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'sessionId padded', data: { uid: 'census_A', sessionId: ' census_S ', generation: 2, attemptSeq: 1, status: 'pending' } },
    ];

    for (const { name, data } of invalidStoredIdentities) {
      const db = new FakeFirestore();
      const uid = 'census_A';
      const sid = 'census_S';
      await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, { isOnDuty: false, dutyGeneration: 1 }));
      await db.doc(`drivers/${uid}/activation_intents/${sid}`).set(data);

      const cancelMgr = createCancelDutyActivationManager({ db });
      const res = await cancelMgr.cancelDutyActivation({
        driverUid: uid,
        sessionId: sid,
        generation: 2,
        attemptSeq: 1,
      });

      assert.equal(res.status, 'cancelled_unaffected');
      const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
      assert.equal(intentDoc.status, 'pending', `intent with ${name} must remain pending and NOT be mutated`);
      assert.equal(intentDoc.cancelledAt, undefined);
    }
  });

  // ============================================================
  // Group F: F16 — Active cancellation associated intent mutation fence (Cases 80–83)
  // ============================================================
  await t.test('F16: active CANCEL deactivates driver but preserves unrelated/mismatched pending intent', async () => {
    const mismatchedAssociatedIntents = [
      { name: 'uid OTHER', intent: { uid: 'OTHER', sessionId: 'census_S', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'sessionId OTHER', intent: { uid: 'census_A', sessionId: 'OTHER', generation: 2, attemptSeq: 1, status: 'pending' } },
      { name: 'generation 9 (mismatch with 2)', intent: { uid: 'census_A', sessionId: 'census_S', generation: 9, attemptSeq: 1, status: 'pending' } },
      { name: 'attemptSeq wrong string', intent: { uid: 'census_A', sessionId: 'census_S', generation: 2, attemptSeq: 'wrong', status: 'pending' } },
    ];

    for (const { name, intent } of mismatchedAssociatedIntents) {
      const db = new FakeFirestore();
      const uid = 'census_A';
      const sid = 'census_S';
      await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
        isOnDuty: true,
        activeDutySessionId: sid,
        dutyGeneration: 2,
        lifecycleSeq: 7,
      }));
      await db.doc(`drivers/${uid}/activation_intents/${sid}`).set(intent);

      const cancelMgr = createCancelDutyActivationManager({ db });
      const res = await cancelMgr.cancelDutyActivation({
        driverUid: uid,
        sessionId: sid,
        generation: 2,
        lifecycleSeq: 7,
      });

      assert.equal(res.status, 'deactivated');
      assert.equal(res.dutyState, 'off');
      assert.equal(res.dutyGeneration, 3);

      const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
      assert.equal(driverDoc.isOnDuty, false);
      assert.equal(driverDoc.dutyGeneration, 3);

      // Mismatched pending intent must remain untouched!
      const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
      assert.equal(intentDoc.status, 'pending', `intent with ${name} must remain pending and NOT be mutated`);
      assert.equal(intentDoc.cancelledAt, undefined);
    }
  });

  // ============================================================
  // Group G: F12 — Literal duty state in END (Cases 53–60)
  // ============================================================
  await t.test('F12: END rejects malformed isOnDuty with failed-precondition and zero writes', async () => {
    const malformedDutyValues = [undefined, null, 'false', 'true', 0, 1, [], {}];

    for (const val of malformedDutyValues) {
      const db = new FakeFirestore();
      const uid = 'census_A';
      const sid = 'census_S';
      const initialDriver = createApprovedDriver(uid, {
        isOnDuty: val,
        activeDutySessionId: sid,
        dutyGeneration: 2,
        lifecycleSeq: 7,
      });
      await db.collection('drivers').doc(uid).set(initialDriver);

      const endMgr = createEndDutySessionManager({ db });
      await assert.rejects(
        async () => {
          await endMgr.endDutySession({
            driverUid: uid,
            sessionId: sid,
            generation: 2,
            lifecycleSeq: 7,
          });
        },
        (err) => err.code === 'failed-precondition' && err.message.includes('isOnDuty'),
      );

      const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
      assert.deepEqual(driverDoc.isOnDuty, val);
      assert.equal(driverDoc.dutyGeneration, 2);
    }
  });

  // ============================================================
  // Group G: F13 — Literal duty state in PREPARE (Cases 61–68)
  // ============================================================
  await t.test('F13: PREPARE rejects malformed isOnDuty with failed-precondition and zero writes', async () => {
    const malformedDutyValues = [undefined, null, 'false', 'true', 0, 1, [], {}];

    for (const val of malformedDutyValues) {
      const db = new FakeFirestore();
      const uid = 'census_A';
      await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
        isOnDuty: val,
        activeDutySessionId: null,
        dutyGeneration: 2,
      }));

      const prepMgr = createPrepareDutyActivationManager({ db });
      await assert.rejects(
        async () => {
          await prepMgr.prepareDutyActivation({ driverUid: uid });
        },
        (err) => err.code === 'failed-precondition' && err.message.includes('isOnDuty'),
      );

      // Verify zero intent documents written
      const intentsSnap = await db.collection(`drivers/${uid}/activation_intents`).get();
      assert.equal(intentsSnap.empty, true);
    }
  });

  // ============================================================
  // Group G: F14 — Literal duty state in CANCEL (Cases 69–76)
  // ============================================================
  await t.test('F14: CANCEL rejects malformed isOnDuty with failed-precondition and zero writes', async () => {
    const malformedDutyValues = [undefined, null, 'false', 'true', 0, 1, [], {}];

    for (const val of malformedDutyValues) {
      const db = new FakeFirestore();
      const uid = 'census_A';
      const sid = 'census_S';
      await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
        isOnDuty: val,
        activeDutySessionId: sid,
        dutyGeneration: 2,
        lifecycleSeq: 7,
      }));
      await db.doc(`drivers/${uid}/activation_intents/${sid}`).set({
        uid,
        sessionId: sid,
        status: 'pending',
        generation: 2,
        attemptSeq: 1,
      });

      const cancelMgr = createCancelDutyActivationManager({ db });
      await assert.rejects(
        async () => {
          await cancelMgr.cancelDutyActivation({
            driverUid: uid,
            sessionId: sid,
            generation: 2,
            lifecycleSeq: 7,
            attemptSeq: 1,
          });
        },
        (err) => err.code === 'failed-precondition' && err.message.includes('isOnDuty'),
      );

      const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
      assert.deepEqual(driverDoc.isOnDuty, val);
      const intentDoc = (await db.doc(`drivers/${uid}/activation_intents/${sid}`).get()).data();
      assert.equal(intentDoc.status, 'pending');
    }
  });

  // ============================================================
  // Group H: F15 — Canonical active session validation (Cases 77–79)
  // ============================================================
  await t.test('F15: padded sessionId is rejected across END, CANCEL, and HEARTBEAT', async () => {
    const db = new FakeFirestore();
    const uid = 'census_A';
    const sid = ' census_S '; // padded

    const endMgr = createEndDutySessionManager({ db });
    const cancelMgr = createCancelDutyActivationManager({ db });
    const hbMgr = createReportLocationHeartbeatManager({ db });

    await assert.rejects(
      async () => endMgr.endDutySession({ driverUid: uid, sessionId: sid, generation: 2, lifecycleSeq: 7 }),
      (err) => err.code === 'invalid-argument',
    );
    await assert.rejects(
      async () => cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId: sid, generation: 2, lifecycleSeq: 7 }),
      (err) => err.code === 'invalid-argument',
    );
    await assert.rejects(
      async () => hbMgr.reportLocationHeartbeat({
        driverUid: uid,
        sessionId: sid,
        generation: 2,
        lifecycleSeq: 7,
        location: { lat: 19.0, lng: 73.0 },
      }),
      (err) => err.code === 'invalid-argument',
    );
  });

  await t.test('F15: padded persisted activeDutySessionId fails closed with failed-precondition', async () => {
    const db = new FakeFirestore();
    const uid = 'census_A';
    const paddedSid = ' census_S ';
    await db.collection('drivers').doc(uid).set(createApprovedDriver(uid, {
      isOnDuty: true,
      activeDutySessionId: paddedSid,
      dutyGeneration: 2,
      lifecycleSeq: 7,
    }));

    const canonicalSid = 'census_S';
    const endMgr = createEndDutySessionManager({ db });
    const cancelMgr = createCancelDutyActivationManager({ db });
    const hbMgr = createReportLocationHeartbeatManager({ db });

    await assert.rejects(
      async () => endMgr.endDutySession({ driverUid: uid, sessionId: canonicalSid, generation: 2, lifecycleSeq: 7 }),
      (err) => err.code === 'failed-precondition' && err.message.includes('noncanonical'),
    );
    await assert.rejects(
      async () => cancelMgr.cancelDutyActivation({ driverUid: uid, sessionId: canonicalSid, generation: 2, lifecycleSeq: 7 }),
      (err) => err.code === 'failed-precondition' && err.message.includes('noncanonical'),
    );
    await assert.rejects(
      async () => hbMgr.reportLocationHeartbeat({
        driverUid: uid,
        sessionId: canonicalSid,
        generation: 2,
        lifecycleSeq: 7,
        location: { lat: 19.0, lng: 73.0 },
      }),
      (err) => err.code === 'failed-precondition' && err.message.includes('noncanonical'),
    );

    // Verify driver remains untouched
    const driverDoc = (await db.doc(`drivers/${uid}`).get()).data();
    assert.equal(driverDoc.isOnDuty, true);
    assert.equal(driverDoc.dutyGeneration, 2);
  });
});
