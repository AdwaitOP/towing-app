'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSubmitDriverVerificationManager,
  createSubmitDriverVerificationCallable,
  isStrictTimestamp,
  isValidVerificationDocs,
  REQUIRED_DOCS,
} = require('../../firebase/functions/src/dispatch/submitDriverVerification');
const {
  FakeFirestore,
  FakeTimestamp,
  FakeFieldValue,
  FakeServerTimestampTransform,
  isServerTimestampSentinel,
} = require('../phase4/fakeDeps');

function createFakeBucket(filesMap = {}, bucketName = 'towing-app.appspot.com') {
  return {
    name: bucketName,
    file(filePath) {
      return {
        name: filePath,
        async exists() {
          return [Boolean(filesMap[filePath])];
        },
      };
    },
  };
}

function createCompleteDriverDoc(overrides = {}) {
  const ts = new FakeTimestamp(100000);
  return {
    uid: 'driver_123',
    name: 'Suresh Raina',
    phone: '+919876543210',
    truckType: 'hydraulic',
    vehicleNumber: 'MH 14 CC 1234',
    isOnDuty: false,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function createCanonicalVerificationDocs(uid, bucketName = 'towing-app.appspot.com') {
  return {
    idPhotoUrl: `gs://${bucketName}/driver_verification/${uid}/id.jpg`,
    rcPhotoUrl: `gs://${bucketName}/driver_verification/${uid}/rc.jpg`,
    selfiePhotoUrl: `gs://${bucketName}/driver_verification/${uid}/selfie.jpg`,
    submittedAt: new FakeTimestamp(100000),
  };
}

function createStandardBucket(uid, bucketName = 'towing-app.appspot.com') {
  return createFakeBucket({
    [`driver_verification/${uid}/id.jpg`]: true,
    [`driver_verification/${uid}/rc.jpg`]: true,
    [`driver_verification/${uid}/selfie.jpg`]: true,
  }, bucketName);
}

function createTestManager(options = {}) {
  return createSubmitDriverVerificationManager({
    TimestampClass: FakeTimestamp,
    FieldValueClass: FakeFieldValue,
    ...options,
  });
}

test('submitDriverVerification: unauthenticated caller fails', async () => {
  const callable = createSubmitDriverVerificationCallable({
    manager: createTestManager({
      db: new FakeFirestore(),
      bucket: createFakeBucket(),
    }),
  });

  await assert.rejects(
    async () => callable.run({ auth: null, data: {} }),
    err => err.code === 'unauthenticated'
  );

  await assert.rejects(
    async () => callable.run({ auth: { uid: '' }, data: {} }),
    err => err.code === 'unauthenticated'
  );
});

test('submitDriverVerification: driver profile not found fails closed', async () => {
  const db = new FakeFirestore();
  const bucket = createStandardBucket('nonexistent_driver');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'nonexistent_driver' }),
    err => err.code === 'not-found'
  );
});

test('submitDriverVerification: persisted uid missing fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  const driverDoc = createCompleteDriverDoc();
  delete driverDoc.uid;
  db.collection('drivers').doc('driver_123').set(driverDoc);

  const bucket = createStandardBucket('driver_123');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_123' }),
    err => err.code === 'failed-precondition' && err.message.includes('UID is missing')
  );

  const snap = await db.collection('drivers').doc('driver_123').get();
  assert.equal(snap.data().verificationStatus, undefined);
});

test('submitDriverVerification: persisted uid null fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  const driverDoc = createCompleteDriverDoc({ uid: null });
  db.collection('drivers').doc('driver_123').set(driverDoc);

  const bucket = createStandardBucket('driver_123');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_123' }),
    err => err.code === 'failed-precondition' && err.message.includes('UID is missing')
  );

  const snap = await db.collection('drivers').doc('driver_123').get();
  assert.equal(snap.data().verificationStatus, undefined);
});

test('submitDriverVerification: persisted uid wrong type fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  const driverDoc = createCompleteDriverDoc({ uid: 12345 });
  db.collection('drivers').doc('driver_123').set(driverDoc);

  const bucket = createStandardBucket('driver_123');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_123' }),
    err => err.code === 'failed-precondition' && err.message.includes('UID is missing')
  );

  const snap = await db.collection('drivers').doc('driver_123').get();
  assert.equal(snap.data().verificationStatus, undefined);
});

test('submitDriverVerification: persisted uid mismatch fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  const driverDoc = createCompleteDriverDoc({ uid: 'other_driver_uid' });
  db.collection('drivers').doc('driver_123').set(driverDoc);

  const bucket = createStandardBucket('driver_123');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_123' }),
    err => err.code === 'failed-precondition' && err.message.includes('UID does not match')
  );

  const snap = await db.collection('drivers').doc('driver_123').get();
  assert.equal(snap.data().verificationStatus, undefined);
});

test('submitDriverVerification: missing or blank name fails closed', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_noname').set(createCompleteDriverDoc({
    uid: 'driver_noname',
    name: '   ',
  }));
  const bucket = createStandardBucket('driver_noname');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_noname' }),
    err => err.code === 'failed-precondition' && err.message.includes('name is missing or blank')
  );
});

test('submitDriverVerification: missing or blank vehicleNumber fails closed', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_novehicle').set(createCompleteDriverDoc({
    uid: 'driver_novehicle',
    vehicleNumber: '',
  }));
  const bucket = createStandardBucket('driver_novehicle');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_novehicle' }),
    err => err.code === 'failed-precondition' && err.message.includes('vehicleNumber is missing or blank')
  );
});

test('submitDriverVerification: invalid phone number fails closed', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_badphone').set(createCompleteDriverDoc({
    uid: 'driver_badphone',
    phone: '12345',
  }));
  const bucket = createStandardBucket('driver_badphone');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_badphone' }),
    err => err.code === 'failed-precondition' && err.message.includes('phone number is invalid')
  );
});

test('submitDriverVerification: invalid truckType fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  const driverDoc = createCompleteDriverDoc({ truckType: 'invalid_type' });
  db.collection('drivers').doc('driver_123').set(driverDoc);

  const bucket = createStandardBucket('driver_123');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_123' }),
    err => err.code === 'failed-precondition' && err.message.includes('Invalid truckType')
  );

  const snap = await db.collection('drivers').doc('driver_123').get();
  assert.equal(snap.data().verificationStatus, undefined);
});

test('submitDriverVerification: non-boolean isOnDuty fails closed', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_duty').set(createCompleteDriverDoc({
    uid: 'driver_duty',
    isOnDuty: 'false',
  }));
  const bucket = createStandardBucket('driver_duty');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_duty' }),
    err => err.code === 'failed-precondition' && err.message.includes('isOnDuty must be a boolean')
  );
});

test('submitDriverVerification: missing createdAt fails closed', async () => {
  const db = new FakeFirestore();
  const doc = createCompleteDriverDoc({ uid: 'driver_nocreated' });
  delete doc.createdAt;
  db.collection('drivers').doc('driver_nocreated').set(doc);
  const bucket = createStandardBucket('driver_nocreated');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_nocreated' }),
    err => err.code === 'failed-precondition' && err.message.includes('createdAt is missing')
  );
});

test('submitDriverVerification: missing updatedAt fails closed', async () => {
  const db = new FakeFirestore();
  const doc = createCompleteDriverDoc({ uid: 'driver_noupdated' });
  delete doc.updatedAt;
  db.collection('drivers').doc('driver_noupdated').set(doc);
  const bucket = createStandardBucket('driver_noupdated');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_noupdated' }),
    err => err.code === 'failed-precondition' && err.message.includes('updatedAt is missing')
  );
});

// ── MALFORMED TIMESTAMPS: STRICT INSTANCE VALIDATION (BLOCKER 1) ──

const malformedTimestampCases = [
  { name: 'empty plain object {}', value: {} },
  { name: 'fake map { seconds: 1, nanoseconds: 0 }', value: { seconds: 1, nanoseconds: 0 } },
  { name: 'JavaScript Date object', value: new Date() },
  { name: 'numeric timestamp integer', value: 1710000000000 },
  { name: 'ISO date string', value: '2026-09-13T00:00:00.000Z' },
  { name: 'fabricated object with .toMillis() method', value: { toMillis: () => 12345 } },
  { name: 'fabricated object with .toDate() method', value: { toDate: () => new Date() } },
  { name: 'map with seconds, nanoseconds, and .toMillis()', value: { seconds: 1, nanoseconds: 0, toMillis: () => 1000 } },
  { name: 'fake serverTimestamp sentinel { _methodName: "serverTimestamp" }', value: { _methodName: 'serverTimestamp' } },
  { name: 'boolean value true', value: true },
  { name: 'array of numbers [123, 456]', value: [123, 456] },
];

for (const { name, value } of malformedTimestampCases) {
  test(`submitDriverVerification: malformed createdAt (${name}) fails closed with zero writes`, async () => {
    const db = new FakeFirestore();
    const uid = 'driver_bad_created';
    const doc = createCompleteDriverDoc({ uid, createdAt: value });
    db.collection('drivers').doc(uid).set(doc);
    const bucket = createStandardBucket(uid);
    const manager = createTestManager({ db, bucket });

    await assert.rejects(
      async () => manager.submitDriverVerification({ driverUid: uid }),
      err => err.code === 'failed-precondition' && err.message.includes('createdAt is missing or invalid Timestamp')
    );

    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().verificationStatus, undefined);
    assert.equal(snap.data().verificationDocs, undefined);
  });

  test(`submitDriverVerification: malformed updatedAt (${name}) fails closed with zero writes`, async () => {
    const db = new FakeFirestore();
    const uid = 'driver_bad_updated';
    const doc = createCompleteDriverDoc({ uid, updatedAt: value });
    db.collection('drivers').doc(uid).set(doc);
    const bucket = createStandardBucket(uid);
    const manager = createTestManager({ db, bucket });

    await assert.rejects(
      async () => manager.submitDriverVerification({ driverUid: uid }),
      err => err.code === 'failed-precondition' && err.message.includes('updatedAt is missing or invalid Timestamp')
    );

    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().verificationStatus, undefined);
    assert.equal(snap.data().verificationDocs, undefined);
  });

  test(`submitDriverVerification: malformed verificationDocs.submittedAt (${name}) on pending fails closed with zero writes`, async () => {
    const db = new FakeFirestore();
    const uid = 'driver_bad_submitted';
    const badDocs = {
      idPhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/id.jpg`,
      rcPhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/rc.jpg`,
      selfiePhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/selfie.jpg`,
      submittedAt: value,
    };
    const doc = createCompleteDriverDoc({
      uid,
      verificationStatus: 'pending',
      verificationDocs: badDocs,
    });
    db.collection('drivers').doc(uid).set(doc);
    const bucket = createStandardBucket(uid);
    const manager = createTestManager({ db, bucket });

    await assert.rejects(
      async () => manager.submitDriverVerification({ driverUid: uid }),
      err => err.code === 'failed-precondition' && err.message.includes('verificationDocs is missing or malformed')
    );

    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().verificationStatus, 'pending');
  });
}

test('submitDriverVerification: malformed optional bannedUntil fails closed', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_bad_ban';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    bannedUntil: { seconds: 1234, nanoseconds: 0 },
  }));
  const bucket = createStandardBucket(uid);
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: uid }),
    err => err.code === 'failed-precondition' && err.message.includes('bannedUntil is invalid Timestamp')
  );
});

test('submitDriverVerification: malformed optional locationUpdatedAt fails closed', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_bad_loc_ts';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    locationUpdatedAt: '2026-09-13T00:00:00Z',
  }));
  const bucket = createStandardBucket(uid);
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: uid }),
    err => err.code === 'failed-precondition' && err.message.includes('locationUpdatedAt is invalid Timestamp')
  );
});

test('submitDriverVerification: malformed verificationDocs on unsubmitted profile fails closed', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_unsub_bad_docs';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: null,
    verificationDocs: { idPhotoUrl: 'not_enough_fields' },
  }));
  const bucket = createStandardBucket(uid);
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: uid }),
    err => err.code === 'failed-precondition' && err.message.includes('verificationDocs is malformed')
  );
});

test('submitDriverVerification: legacy verified driver fails closed as malformed state with zero writes', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_legacy').set(createCompleteDriverDoc({
    uid: 'driver_legacy',
    verificationStatus: 'verified',
  }));
  const bucket = createStandardBucket('driver_legacy');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_legacy' }),
    err => err.code === 'failed-precondition' && err.message.includes('verificationStatus is invalid/malformed')
  );

  const snap = await db.collection('drivers').doc('driver_legacy').get();
  assert.equal(snap.data().verificationStatus, 'verified');
});

test('submitDriverVerification: malformed verificationDocs on pending fails closed with zero writes', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_bad_docs').set(createCompleteDriverDoc({
    uid: 'driver_bad_docs',
    verificationStatus: 'pending',
    verificationDocs: { idPhotoUrl: '' },
  }));
  const bucket = createStandardBucket('driver_bad_docs');
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_bad_docs' }),
    err => err.code === 'failed-precondition' && err.message.includes('verificationDocs is missing or malformed')
  );
});

test('submitDriverVerification: already approved driver cannot re-submit and preserves approved status', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_appr';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: 'approved',
    verificationDocs: createCanonicalVerificationDocs(uid),
  }));
  const bucket = createStandardBucket(uid);
  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: uid }),
    err => err.code === 'failed-precondition' && err.message.includes('already verified and approved')
  );

  const snap = await db.collection('drivers').doc(uid).get();
  assert.equal(snap.data().verificationStatus, 'approved');
});

test('submitDriverVerification: missing storage objects fails with zero writes', async () => {
  const db = new FakeFirestore();
  db.collection('drivers').doc('driver_missing_docs').set(createCompleteDriverDoc({
    uid: 'driver_missing_docs',
  }));

  const bucket = createFakeBucket({
    'driver_verification/driver_missing_docs/id.jpg': true,
    'driver_verification/driver_missing_docs/rc.jpg': true,
  });

  const manager = createTestManager({ db, bucket });

  await assert.rejects(
    async () => manager.submitDriverVerification({ driverUid: 'driver_missing_docs' }),
    err => err.code === 'failed-precondition' && err.message.includes('selfie.jpg')
  );

  const snap = await db.collection('drivers').doc('driver_missing_docs').get();
  assert.equal(snap.data().verificationStatus, undefined);
  assert.equal(snap.data().verificationDocs, undefined);
});

test('submitDriverVerification: all canonical truckTypes succeed', async () => {
  const canonicalTruckTypes = ['flatbed', 'tochan', 'hydraulic', 'crane'];
  for (const tType of canonicalTruckTypes) {
    const db = new FakeFirestore();
    const uid = `driver_${tType}`;
    db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
      uid,
      truckType: tType,
    }));
    const bucket = createStandardBucket(uid);
    const manager = createTestManager({ db, bucket });

    const result = await manager.submitDriverVerification({ driverUid: uid });
    assert.deepEqual(result, { success: true, status: 'pending' });
    const snap = await db.collection('drivers').doc(uid).get();
    assert.equal(snap.data().verificationStatus, 'pending');
  }
});

test('submitDriverVerification: valid submission creates pending status, gs:// URLs and clears rejectionReason', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_valid';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: 'rejected',
    rejectionReason: 'ID was blurry previously',
    verificationDocs: createCanonicalVerificationDocs(uid, 'towing-prod.appspot.com'),
  }));

  const bucket = createStandardBucket(uid, 'towing-prod.appspot.com');
  const manager = createTestManager({
    db,
    bucket,
  });

  const result = await manager.submitDriverVerification({ driverUid: uid });

  assert.deepEqual(result, { success: true, status: 'pending' });

  const snap = await db.collection('drivers').doc(uid).get();
  const updatedData = snap.data();

  assert.equal(updatedData.verificationStatus, 'pending');
  assert.equal(updatedData.rejectionReason, null);
  assert.ok(updatedData.updatedAt instanceof FakeTimestamp);

  assert.ok(updatedData.verificationDocs);
  assert.equal(
    updatedData.verificationDocs.idPhotoUrl,
    `gs://towing-prod.appspot.com/driver_verification/${uid}/id.jpg`
  );
  assert.equal(
    updatedData.verificationDocs.rcPhotoUrl,
    `gs://towing-prod.appspot.com/driver_verification/${uid}/rc.jpg`
  );
  assert.equal(
    updatedData.verificationDocs.selfiePhotoUrl,
    `gs://towing-prod.appspot.com/driver_verification/${uid}/selfie.jpg`
  );
  assert.ok(updatedData.verificationDocs.submittedAt instanceof FakeTimestamp);
});

test('submitDriverVerification: write uses serverTimestamp sentinel for submittedAt and updatedAt (BLOCKER 2)', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_server_ts';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: null,
  }));

  let serverTimestampCount = 0;
  const spySentinel = new FakeServerTimestampTransform();
  const spyFieldValue = {
    serverTimestamp: () => {
      serverTimestampCount++;
      return spySentinel;
    },
  };

  const bucket = createStandardBucket(uid);
  const manager = createSubmitDriverVerificationManager({
    db,
    bucket,
    TimestampClass: FakeTimestamp,
    FieldValueClass: spyFieldValue,
  });

  const result = await manager.submitDriverVerification({ driverUid: uid });
  assert.deepEqual(result, { success: true, status: 'pending' });

  // Verify serverTimestamp() was called exactly twice (for submittedAt and updatedAt)
  assert.equal(serverTimestampCount, 2, 'FieldValue.serverTimestamp() must be invoked exactly twice');

  // Verify that the payload sent to transaction.update contained the serverTimestamp sentinel
  assert.equal(db.lastTransactionUpdates.length, 1, 'Exactly one transaction.update must be executed');
  const updatePayload = db.lastTransactionUpdates[0].value;

  assert.equal(updatePayload.updatedAt, spySentinel, 'updatedAt written must be the serverTimestamp sentinel');
  assert.equal(updatePayload.verificationDocs.submittedAt, spySentinel, 'submittedAt written must be the serverTimestamp sentinel');
});

test('submitDriverVerification: duplicate/concurrent pending submission is idempotent, preserves submittedAt, and executes ZERO writes', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_pending';
  const originalSubmittedAt = new FakeTimestamp(500000);
  const initialDoc = createCompleteDriverDoc({
    uid,
    verificationStatus: 'pending',
    verificationDocs: {
      idPhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/id.jpg`,
      rcPhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/rc.jpg`,
      selfiePhotoUrl: `gs://towing-app.appspot.com/driver_verification/${uid}/selfie.jpg`,
      submittedAt: originalSubmittedAt,
    },
  });
  db.collection('drivers').doc(uid).set(initialDoc);

  let serverTimestampCount = 0;
  const spyFieldValue = {
    serverTimestamp: () => {
      serverTimestampCount++;
      return new FakeServerTimestampTransform();
    },
  };

  const bucket = createStandardBucket(uid);
  const manager = createSubmitDriverVerificationManager({
    db,
    bucket,
    TimestampClass: FakeTimestamp,
    FieldValueClass: spyFieldValue,
  });

  // Reset tracking
  db.lastTransactionUpdates = [];

  const result = await manager.submitDriverVerification({ driverUid: uid });
  assert.deepEqual(result, { success: true, status: 'pending' });

  // Prove ZERO writes and ZERO calls to serverTimestamp
  assert.equal(serverTimestampCount, 0, 'No serverTimestamp calls on idempotent resubmit');
  assert.equal(db.lastTransactionUpdates.length, 0, 'No transaction updates on idempotent resubmit');

  const snap = await db.collection('drivers').doc(uid).get();
  assert.deepEqual(snap.data().verificationDocs.submittedAt, originalSubmittedAt);
});

test('submitDriverVerification: concurrent unsubmitted submissions with scheduling barrier: only 1 effective transition, zero submittedAt churn', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_concurrent_barrier';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: null,
  }));

  const bucket = createStandardBucket(uid);
  const manager = createTestManager({
    db,
    bucket,
  });

  let call1EnteredTx = false;
  let resumeCall1;
  const barrierPromise = new Promise(resolve => { resumeCall1 = resolve; });

  const transactionObservations = [];
  const origRunTransaction = db.runTransaction.bind(db);
  let txCount = 0;
  db.runTransaction = async (callback) => {
    txCount++;
    const currentTx = txCount;
    const observation = {
      txIndex: currentTx,
      observedVerificationStatus: undefined,
      updates: [],
    };
    transactionObservations.push(observation);

    return await origRunTransaction(async (tx) => {
      const instrumentedTx = {
        async get(docRef) {
          const docSnap = await tx.get(docRef);
          if (docRef.id === uid || docRef.path === `drivers/${uid}`) {
            observation.observedVerificationStatus = docSnap.data()?.verificationStatus ?? null;
          }
          return docSnap;
        },
        update(docRef, updateData) {
          observation.updates.push({ path: docRef.path, updateData });
          return tx.update(docRef, updateData);
        },
        set(docRef, data, options) {
          return tx.set(docRef, data, options);
        },
        delete(docRef) {
          return tx.delete(docRef);
        },
      };

      if (currentTx === 1) {
        call1EnteredTx = true;
        await barrierPromise;
      }
      return await callback(instrumentedTx);
    });
  };

  const call1Promise = manager.submitDriverVerification({ driverUid: uid });

  while (!call1EnteredTx) {
    await new Promise(r => setTimeout(r, 5));
  }

  resumeCall1();
  const [res1, res2] = await Promise.all([
    call1Promise,
    manager.submitDriverVerification({ driverUid: uid }),
  ]);

  assert.deepEqual(res1, { success: true, status: 'pending' });
  assert.deepEqual(res2, { success: true, status: 'pending' });

  // Assert transaction observations: Tx 1 observed unsubmitted/null and wrote, Tx 2 observed pending and wrote 0
  assert.equal(transactionObservations.length, 2, 'Exactly two transactions executed');
  assert.equal(transactionObservations[0].observedVerificationStatus, null, 'Tx #1 observed unsubmitted/null');
  assert.equal(transactionObservations[0].updates.length, 1, 'Tx #1 executed transaction.update exactly once');
  assert.equal(transactionObservations[0].updates[0].updateData.verificationStatus, 'pending');

  assert.equal(transactionObservations[1].observedVerificationStatus, 'pending', 'Tx #2 observed pending');
  assert.equal(transactionObservations[1].updates.length, 0, 'Tx #2 executed zero writes (idempotent no-op)');

  // Assert exactly 1 transaction write occurred across both overlapping calls (Finding 5B)
  assert.equal(db.lastTransactionUpdates.length, 1, 'Only one transaction write across both overlapping initial calls');

  const snap = await db.collection('drivers').doc(uid).get();
  assert.equal(snap.data().verificationStatus, 'pending');
  assert.ok(snap.data().verificationDocs.submittedAt instanceof FakeTimestamp);
  assert.ok(snap.data().updatedAt instanceof FakeTimestamp);

  const committedSubmittedAt = snap.data().verificationDocs.submittedAt;
  const committedUpdatedAt = snap.data().updatedAt;

  // Verify second call caused zero timestamp churn across submittedAt and updatedAt (doc retains exact timestamps)
  const snapAfter = await db.collection('drivers').doc(uid).get();
  assert.deepEqual(snapAfter.data().verificationDocs.submittedAt, committedSubmittedAt);
  assert.deepEqual(snapAfter.data().updatedAt, committedUpdatedAt);
  assert.equal(db.lastTransactionUpdates.length, 1, 'No additional transaction updates executed on second call');
});

test('submitDriverVerification: admin race: admin approves while submission in flight -> driver submission rejected and approved preserved', async () => {
  const db = new FakeFirestore();
  const uid = 'driver_admin_race';
  db.collection('drivers').doc(uid).set(createCompleteDriverDoc({
    uid,
    verificationStatus: null,
  }));

  const bucket = createStandardBucket(uid);
  const manager = createTestManager({
    db,
    bucket,
  });

  let pauseCallback;
  const pausePromise = new Promise(r => { pauseCallback = r; });
  let adminApproved = false;

  const origRunTransaction = db.runTransaction.bind(db);
  db.runTransaction = async (callback) => {
    return await origRunTransaction(async (tx) => {
      if (!adminApproved) {
        await pausePromise;
      }
      return await callback(tx);
    });
  };

  const submitPromise = manager.submitDriverVerification({ driverUid: uid });

  await db.collection('drivers').doc(uid).update({
    verificationStatus: 'approved',
    verificationDocs: createCanonicalVerificationDocs(uid),
  });
  adminApproved = true;
  pauseCallback();

  await assert.rejects(
    async () => await submitPromise,
    err => err.code === 'failed-precondition' && err.message.includes('already verified and approved')
  );

  const snap = await db.collection('drivers').doc(uid).get();
  assert.equal(snap.data().verificationStatus, 'approved');
});

test('submitDriverVerification: canonical storage path & filenames prove PATH CONTRACT compatibility with retentionCleanup job', () => {
  const fs = require('fs');
  const path = require('path');
  const retentionCleanupSrc = fs.readFileSync(path.resolve(__dirname, '../../firebase/functions/src/jobs/retentionCleanup.js'), 'utf8');

  assert.ok(retentionCleanupSrc.includes("const photoKeys = ['id.jpg', 'rc.jpg', 'selfie.jpg'];"), 'retentionCleanup must define exact photoKeys');
  assert.ok(retentionCleanupSrc.includes("`driver_verification/${driverId}/${filename}`"), 'retentionCleanup must target driver_verification root');

  const submitDocFilenames = REQUIRED_DOCS.map(d => d.filename);
  assert.deepEqual(submitDocFilenames, ['id.jpg', 'rc.jpg', 'selfie.jpg']);
});
