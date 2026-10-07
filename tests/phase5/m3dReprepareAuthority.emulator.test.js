'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');
const { createPrepareDutyActivationManager } = require('../../firebase/functions/src/duty/prepareDutyActivation');
const { createStartDutySessionManager } = require('../../firebase/functions/src/duty/startDutySession');

const uid = 'driver_reprepare';
const sessionId = 'session_reprepare';

function fixture() {
  const db = new FakeFirestore();
  db.seed('drivers', uid, {
    uid, verificationStatus: 'approved', isOnDuty: false,
    activeDutySessionId: null, activeJobId: null, activeOfferId: null,
    dutyGeneration: 1, workerReady: false,
  });
  db.seed(`drivers/${uid}/activation_intents`, sessionId, {
    uid, sessionId, status: 'pending', generation: 2, attemptSeq: 1,
    createdAt: FakeTimestamp.fromMillis(Date.now()),
    updatedAt: FakeTimestamp.fromMillis(Date.now()),
    expiresAt: FakeTimestamp.fromMillis(Date.now() + 60_000),
  });
  return db;
}

async function rejectsWithoutWrites(name, mutate) {
  await test(name, async () => {
    const db = fixture();
    const path = `drivers/${uid}/activation_intents`;
    mutate(db.data[path][sessionId]);
    const beforeDriver = db.read('drivers', uid);
    const beforeIntent = db.read(path, sessionId);
    const prepare = createPrepareDutyActivationManager({ db });
    await assert.rejects(
      prepare.prepareDutyActivation({ driverUid: uid, sessionId }),
      (error) => error.code === 'failed-precondition',
    );
    assert.deepEqual(db.lastTransactionUpdates, [], 'No intent or driver writes may be scheduled');
    assert.deepEqual(db.read('drivers', uid), beforeDriver);
    assert.deepEqual(db.read(path, sessionId), beforeIntent);
  });
}

rejectsWithoutWrites('D-REPREPARE-1: string attemptSeq', (intent) => { intent.attemptSeq = '1'; });
rejectsWithoutWrites('D-REPREPARE-2: mismatched uid', (intent) => { intent.uid = 'other_driver'; });
rejectsWithoutWrites('D-REPREPARE-3: mismatched sessionId', (intent) => { intent.sessionId = 'other_session'; });
rejectsWithoutWrites('D-REPREPARE-4: string generation', (intent) => { intent.generation = '2'; });
rejectsWithoutWrites('D-REPREPARE-5a: missing generation', (intent) => { delete intent.generation; });
rejectsWithoutWrites('D-REPREPARE-5b: null generation', (intent) => { intent.generation = null; });
rejectsWithoutWrites('D-REPREPARE-6a: missing attemptSeq', (intent) => { delete intent.attemptSeq; });
rejectsWithoutWrites('D-REPREPARE-6b: null attemptSeq', (intent) => { intent.attemptSeq = null; });
rejectsWithoutWrites('D-REPREPARE-7: fractional attemptSeq', (intent) => { intent.attemptSeq = 1.5; });
rejectsWithoutWrites('D-REPREPARE-8: maximum safe attemptSeq', (intent) => { intent.attemptSeq = Number.MAX_SAFE_INTEGER; });
rejectsWithoutWrites('D-REPREPARE-9: unsafe attemptSeq', (intent) => { intent.attemptSeq = Number.MAX_SAFE_INTEGER + 1; });
rejectsWithoutWrites('D-REPREPARE-extra: malformed canonical uid', (intent) => { intent.uid = ` ${uid}`; });
rejectsWithoutWrites('D-REPREPARE-extra: malformed canonical sessionId', (intent) => { intent.sessionId = ` ${sessionId}`; });
rejectsWithoutWrites('D-REPREPARE-extra: mismatched generation', (intent) => { intent.generation = 3; });

test('D-REPREPARE-10: exact pending authority increments only attemptSeq and expiry metadata', async () => {
  const db = fixture();
  const path = `drivers/${uid}/activation_intents`;
  const before = db.read(path, sessionId);
  const prepare = createPrepareDutyActivationManager({ db });
  const result = await prepare.prepareDutyActivation({ driverUid: uid, sessionId });
  const after = db.read(path, sessionId);
  assert.equal(result.idempotent, true);
  assert.deepEqual([result.sessionId, result.generation, result.attemptSeq], [sessionId, 2, 2]);
  assert.deepEqual(db.lastTransactionUpdates.map(({ type, ref }) => [type, ref.path, ref.id]), [['update', path, sessionId]]);
  for (const field of ['uid', 'sessionId', 'generation', 'status', 'createdAt']) {
    assert.deepEqual(after[field], before[field], `${field} must remain unchanged`);
  }
  assert.equal(after.attemptSeq, 2);
  assert.deepEqual(db.read('drivers', uid).dutyGeneration, 1);
});

test('D-REPREPARE-11: exact reprepared authority activates', async () => {
  const db = fixture();
  const prepare = createPrepareDutyActivationManager({ db });
  const start = createStartDutySessionManager({ db });
  const pending = await prepare.prepareDutyActivation({ driverUid: uid, sessionId });
  const activated = await start.startDutySession({
    driverUid: uid, sessionId: pending.sessionId, generation: pending.generation,
    attemptSeq: pending.attemptSeq, lifecycleSeq: 1,
    initialLocation: { lat: 18.5204, lng: 73.8567 },
  });
  assert.equal(activated.status, 'activated');
  assert.equal(db.read('drivers', uid).dutyGeneration, pending.generation);
  assert.equal(Object.hasOwn(db.read('drivers', uid), 'attemptSeq'), false);
  assert.equal(db.read(`drivers/${uid}/activation_intents`, sessionId).status, 'activated');
});
