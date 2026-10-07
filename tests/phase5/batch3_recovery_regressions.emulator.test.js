'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { GeoPoint } = require('firebase-admin/firestore');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');

const { createRecoverActiveJobSessionManager } = require('../../firebase/functions/src/duty/recoverActiveJobSession');

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

function createRecoverableDriver(uid, sessionId, gen = 1, lifecycleSeq = 1, jobId = 'job_census') {
  return createApprovedDriver(uid, {
    isOnDuty: true,
    workerReady: true,
    activeDutySessionId: sessionId,
    dutyGeneration: gen,
    lifecycleSeq: lifecycleSeq,
    activeJobId: jobId,
    locationUpdatedAt: FakeTimestamp.fromMillis(Date.now() - 120_000), // 120s ago — past 60s silence
  });
}

test('Batch 3: Group I (F17–F18) Recovery Duplicate Validation Regressions', async (t) => {
  // ============================================================
  // Group I: F17 — Exact duplicate intent binding (Cases 84, 85, 88)
  // ============================================================
  await t.test('F17: duplicate recovery rejects corrupted persisted uid (Case 84)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_f17_84';
    const clientReqId = 'req_f17_84';
    const hash = crypto.createHash('sha256').update(clientReqId.trim()).digest('hex').slice(0, 16);
    const proposedSessionId = `${uid}_rec_${hash}`;

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_f17'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_f17',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Mutate the persisted intent doc to have a corrupted uid
    await db.doc(`drivers/${uid}/activation_intents/${proposedSessionId}`).update({
      uid: 'corrupted_other_uid',
    });

    // Replay duplicate recovery with exact same parameters
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_old',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_f17',
          clientRequestId: clientReqId,
        });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.ok(err.message.includes('cannot be reused: state has diverged'));
        return true;
      }
    );
  });

  await t.test('F17: duplicate recovery rejects corrupted persisted sessionId (Case 85)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_f17_85';
    const clientReqId = 'req_f17_85';
    const hash = crypto.createHash('sha256').update(clientReqId.trim()).digest('hex').slice(0, 16);
    const proposedSessionId = `${uid}_rec_${hash}`;

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_f17'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_f17',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Mutate the persisted intent doc to have a corrupted sessionId
    await db.doc(`drivers/${uid}/activation_intents/${proposedSessionId}`).update({
      sessionId: 'corrupted_other_session_id',
    });

    // Replay duplicate recovery
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_old',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_f17',
          clientRequestId: clientReqId,
        });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.ok(err.message.includes('cannot be reused: state has diverged'));
        return true;
      }
    );
  });

  await t.test('F17: duplicate recovery rejects corrupted sourceActiveJobId (Case 88)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_f17_88';
    const clientReqId = 'req_f17_88';
    const hash = crypto.createHash('sha256').update(clientReqId.trim()).digest('hex').slice(0, 16);
    const proposedSessionId = `${uid}_rec_${hash}`;

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_f17'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_f17',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Mutate sourceActiveJobId on the intent doc to be corrupted
    await db.doc(`drivers/${uid}/activation_intents/${proposedSessionId}`).update({
      sourceActiveJobId: 'corrupted_job_id',
    });

    // Replay duplicate recovery
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_old',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_f17',
          clientRequestId: clientReqId,
        });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.ok(err.message.includes('cannot be reused: state has diverged'));
        return true;
      }
    );
  });

  // ============================================================
  // Group I: F18 — Malformed active lifecycle validation (Cases 89–92)
  // ============================================================
  await t.test('F18: duplicate recovery rejects malformed active lifecycle when workerReady is true (Cases 89-92)', async () => {
    const malformedLifecycles = [
      { name: 'missing/null (Case 89)', value: null },
      { name: 'string (Case 90)', value: '1' },
      { name: 'zero (Case 91)', value: 0 },
      { name: 'unsafe integer (Case 92)', value: Number.MAX_SAFE_INTEGER + 10 },
      { name: 'negative number', value: -1 },
    ];

    for (const { name, value } of malformedLifecycles) {
      const db = new FakeFirestore();
      const uid = `driver_f18_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const clientReqId = `req_f18_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;

      await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_f18'));

      const recMgr = createRecoverActiveJobSessionManager({ db });
      const rec1 = await recMgr.recoverActiveJobSession({
        driverUid: uid,
        activeDutySessionId: 'sess_old',
        dutyGeneration: 1,
        lifecycleSeq: 1,
        expectedActiveJobId: 'job_f18',
        clientRequestId: clientReqId,
      });
      assert.equal(rec1.status, 'recovered');

      // Now set driver.workerReady = true but with malformed lifecycleSeq
      await db.collection('drivers').doc(uid).update({
        workerReady: true,
        lifecycleSeq: value,
      });

      // Replay duplicate recovery — must reject because lifecycleSeq is not a positive safe integer
      await assert.rejects(
        async () => {
          await recMgr.recoverActiveJobSession({
            driverUid: uid,
            activeDutySessionId: 'sess_old',
            dutyGeneration: 1,
            lifecycleSeq: 1,
            expectedActiveJobId: 'job_f18',
            clientRequestId: clientReqId,
          });
        },
        (err) => {
          assert.equal(err.code, 'failed-precondition');
          assert.ok(err.message.includes('cannot be reused: state has diverged'));
          return true;
        },
        `Expected rejection for malformed lifecycle: ${name}`
      );
    }
  });

  // ============================================================
  // Positive Controls & Excluded Cases
  // ============================================================
  await t.test('Positive Control: valid initial duplicate recovery (workerReady=false, lifecycleSeq=null)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_pos_initial';
    const clientReqId = 'req_pos_initial';

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_pos'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_pos',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');
    assert.equal(rec1.workerReady, false);

    // Replay duplicate recovery without workerReady having been established yet
    const rec2 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_pos',
      clientRequestId: clientReqId,
    });
    assert.equal(rec2.status, 'already_recovered');
    assert.equal(rec2.sessionId, rec1.sessionId);
    assert.equal(rec2.dutyGeneration, rec1.dutyGeneration);
    assert.equal(rec2.workerReady, false);
    assert.equal(rec2.lifecycleSeq, null);
  });

  await t.test('Positive Control: valid post-heartbeat duplicate recovery (workerReady=true, lifecycleSeq=2)', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_pos_ready';
    const clientReqId = 'req_pos_ready';

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_pos_ready'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_pos_ready',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Simulate driver sending valid heartbeat: workerReady becomes true, lifecycleSeq becomes 2
    await db.collection('drivers').doc(uid).update({
      workerReady: true,
      lifecycleSeq: 2,
    });

    // Replay duplicate recovery
    const rec2 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_pos_ready',
      clientRequestId: clientReqId,
    });
    assert.equal(rec2.status, 'already_recovered');
    assert.equal(rec2.sessionId, rec1.sessionId);
    assert.equal(rec2.dutyGeneration, rec1.dutyGeneration);
    assert.equal(rec2.workerReady, true);
    assert.equal(rec2.lifecycleSeq, 2);
  });

  await t.test('Census Excluded: corrupted alias fields recoveredSessionId and recoveredDutyGeneration (Cases 86 & 87) do not block duplicate replay', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_excluded_alias';
    const clientReqId = 'req_excluded_alias';
    const hash = crypto.createHash('sha256').update(clientReqId.trim()).digest('hex').slice(0, 16);
    const proposedSessionId = `${uid}_rec_${hash}`;

    await db.collection('drivers').doc(uid).set(createRecoverableDriver(uid, 'sess_old', 1, 1, 'job_alias'));

    const recMgr = createRecoverActiveJobSessionManager({ db });
    const rec1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_alias',
      clientRequestId: clientReqId,
    });
    assert.equal(rec1.status, 'recovered');

    // Mutate alias fields (Cases 86 & 87) — these are not canonical gates
    await db.doc(`drivers/${uid}/activation_intents/${proposedSessionId}`).update({
      recoveredSessionId: 'corrupted_alias_sess',
      recoveredDutyGeneration: 999,
    });

    // Replay duplicate recovery — must still succeed as already_recovered
    const rec2 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_alias',
      clientRequestId: clientReqId,
    });
    assert.equal(rec2.status, 'already_recovered');
    assert.equal(rec2.sessionId, rec1.sessionId);
  });
});
