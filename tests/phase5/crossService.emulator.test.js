'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Initialize Admin SDK via canonical project configuration
require('../../firebase/functions/src/config/adminInit');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'towing-phase5-storage';
const db = getFirestore();
const storage = getStorage();
const bucket = storage.bucket();

const { submitDriverVerification } = require('../../firebase/functions/src/dispatch/submitDriverVerification');

test('Cross-Service Emulator Integration Test: Firestore + Storage + submitDriverVerification', async (t) => {
  const RUN_ID = randomUUID().slice(0, 8);

  // ── 1. HAPPY PATH: Real upload -> submit -> Firestore pending -> gs:// URLs ──
  await t.test('Happy Path: 3 documents in Storage -> submit -> Firestore updated to pending with gs:// URLs & rejectionReason null', async () => {
    const driverUid = `int_driver_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    // 1. Create canonical driver document in real Firestore
    await driverRef.set({
      uid: driverUid,
      name: 'Arjun Tendulkar',
      phone: '+919876543210',
      truckType: 'flatbed',
      vehicleNumber: 'MH 01 AB 1234',
      isOnDuty: false,
      rejectionReason: 'Previous photo blurry', // Should be cleared to null on submit
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 2. Upload the 3 required KYC photos to real Storage emulator
    const idPath = `driver_verification/${driverUid}/id.jpg`;
    const rcPath = `driver_verification/${driverUid}/rc.jpg`;
    const selfiePath = `driver_verification/${driverUid}/selfie.jpg`;

    await bucket.file(idPath).save(Buffer.from('id-jpeg-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(rcPath).save(Buffer.from('rc-jpeg-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(selfiePath).save(Buffer.from('selfie-jpeg-bytes'), { contentType: 'image/jpeg' });

    // Verify real Storage files exist
    const [idExists] = await bucket.file(idPath).exists();
    const [rcExists] = await bucket.file(rcPath).exists();
    const [selfieExists] = await bucket.file(selfiePath).exists();
    assert.equal(idExists, true, 'id.jpg must exist in real Storage');
    assert.equal(rcExists, true, 'rc.jpg must exist in real Storage');
    assert.equal(selfieExists, true, 'selfie.jpg must exist in real Storage');

    // 3. Invoke actual exported submitDriverVerification callable against real emulators
    const result = await submitDriverVerification.run({
      auth: { uid: driverUid },
    });

    assert.deepEqual(result, { success: true, status: 'pending' });

    // 4. Verify real Firestore driver document state
    const driverSnap = await driverRef.get();
    const data = driverSnap.data();

    assert.equal(data.verificationStatus, 'pending');
    assert.equal(data.rejectionReason, null);
    assert.ok(data.verificationDocs, 'verificationDocs must exist');
    assert.equal(data.verificationDocs.idPhotoUrl, `gs://${bucket.name}/${idPath}`);
    assert.equal(data.verificationDocs.rcPhotoUrl, `gs://${bucket.name}/${rcPath}`);
    assert.equal(data.verificationDocs.selfiePhotoUrl, `gs://${bucket.name}/${selfiePath}`);
    assert.ok(data.verificationDocs.submittedAt instanceof Timestamp, 'submittedAt must be Firestore Timestamp');

    const firstSubmittedAt = data.verificationDocs.submittedAt;

    // 5. Idempotency test: second submission preserves submittedAt and leaves status pending
    await new Promise(r => setTimeout(r, 50));
    const result2 = await submitDriverVerification.run({
      auth: { uid: driverUid },
    });
    assert.deepEqual(result2, { success: true, status: 'pending' });

    const driverSnap2 = await driverRef.get();
    const data2 = driverSnap2.data();
    assert.equal(data2.verificationStatus, 'pending');
    assert.equal(data2.verificationDocs.submittedAt.toMillis(), firstSubmittedAt.toMillis(), 'submittedAt must not churn on idempotent resubmit');
  });

  // ── 2. MISSING STORAGE OBJECT: Missing selfie.jpg -> fails closed ─────────
  await t.test('Missing Storage Object: missing selfie.jpg terminates with failed-precondition and zero writes', async () => {
    const driverUid = `int_missing_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      name: 'Rohan Gavaskar',
      phone: '+919876543211',
      truckType: 'hydraulic',
      vehicleNumber: 'MH 02 CD 5678',
      isOnDuty: false,
    });

    // Upload only id and rc, but omit selfie
    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({
          auth: { uid: driverUid },
        });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /Missing required KYC document: selfie\.jpg/);
        return true;
      }
    );

    // Verify ZERO writes occurred to Firestore verificationStatus
    const snap = await driverRef.get();
    assert.equal(snap.data().verificationStatus, undefined);
    assert.equal(snap.data().verificationDocs, undefined);
  });

  // ── 3. ALREADY APPROVED: Approved driver cannot re-submit ─────────────────
  await t.test('Approved Driver: re-submission rejected with failed-precondition and approved preserved', async () => {
    const driverUid = `int_approved_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    // Upload storage files
    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    await driverRef.set({
      uid: driverUid,
      name: 'Sachin Tendulkar',
      phone: '+919876543212',
      truckType: 'crane',
      vehicleNumber: 'MH 03 EF 9999',
      isOnDuty: false,
      verificationStatus: 'approved',
      verificationDocs: {
        idPhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/id.jpg`,
        rcPhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/rc.jpg`,
        selfiePhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/selfie.jpg`,
        submittedAt: Timestamp.now(),
      },
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({
          auth: { uid: driverUid },
        });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /Driver is already verified and approved/);
        return true;
      }
    );

    const snap = await driverRef.get();
    assert.equal(snap.data().verificationStatus, 'approved');
  });

  // ── 4. IDENTITY GUARDRAILS: Unauthenticated, Not Found, Mismatched UID ────
  await t.test('Identity Guardrails: Unauthenticated, non-existent, and mismatched UID are rejected', async () => {
    // 4a. Unauthenticated caller
    await assert.rejects(
      async () => {
        await submitDriverVerification.run({ auth: null });
      },
      (err) => {
        assert.equal(err.code, 'unauthenticated');
        return true;
      }
    );

    // 4b. Profile not found (Storage files exist, but doc does not exist in Firestore)
    const notFoundUid = `int_notfound_${RUN_ID}`;
    await bucket.file(`driver_verification/${notFoundUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${notFoundUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${notFoundUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({ auth: { uid: notFoundUid } });
      },
      (err) => {
        assert.equal(err.code, 'not-found');
        return true;
      }
    );

    // 4c. Mismatched persisted UID in Firestore
    const driverUid = `int_mismatch_${RUN_ID}`;
    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    await db.collection('drivers').doc(driverUid).set({
      uid: 'fraudulent_other_uid',
      name: 'Fake Driver',
      phone: '+919876543213',
      truckType: 'tochan',
      vehicleNumber: 'MH 04 GH 1111',
      isOnDuty: false,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({ auth: { uid: driverUid } });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /Driver profile UID does not match document ID/);
        return true;
      }
    );
  });

  // ── 5. ADMIN RACE PROBE AGAINST REAL EMULATORS ────────────────────────────
  await t.test('Admin Race: admin approves while submission in flight -> driver submission rejected and approval preserved', async () => {
    const driverUid = `int_admin_race_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      name: 'Zaheer Khan',
      phone: '+919876543214',
      truckType: 'flatbed',
      vehicleNumber: 'MH 12 QW 1234',
      isOnDuty: false,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    // Admin updates doc to approved before/during submission
    await driverRef.update({
      verificationStatus: 'approved',
      verificationDocs: {
        idPhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/id.jpg`,
        rcPhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/rc.jpg`,
        selfiePhotoUrl: `gs://${bucket.name}/driver_verification/${driverUid}/selfie.jpg`,
        submittedAt: Timestamp.now(),
      },
      updatedAt: Timestamp.now(),
    });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({ auth: { uid: driverUid } });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /already verified and approved/);
        return true;
      }
    );

    const snap = await driverRef.get();
    assert.equal(snap.data().verificationStatus, 'approved');
  });

  // ── 6. CONCURRENT SUBMISSIONS PROBE AGAINST REAL EMULATORS ─────────────────
  await t.test('Concurrent Submissions: two overlapping initial calls transition cleanly to pending with single submittedAt', async () => {
    const driverUid = `int_concurrent_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      name: 'Yuvraj Singh',
      phone: '+919876543215',
      truckType: 'hydraulic',
      vehicleNumber: 'MH 14 YS 1234',
      isOnDuty: false,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    let committedUpdates = 0;
    const origRunTransaction = db.runTransaction.bind(db);

    try {
      db.runTransaction = async (callback) => {
        let calledUpdate = false;
        const res = await origRunTransaction(async (tx) => {
          calledUpdate = false;
          const origUpdate = tx.update.bind(tx);
          tx.update = (ref, data, ...rest) => {
            if (ref.path === driverRef.path) {
              calledUpdate = true;
            }
            return origUpdate(ref, data, ...rest);
          };
          return await callback(tx);
        });
        if (calledUpdate) {
          committedUpdates++;
        }
        return res;
      };

      const [res1, res2] = await Promise.all([
        submitDriverVerification.run({ auth: { uid: driverUid } }),
        submitDriverVerification.run({ auth: { uid: driverUid } }),
      ]);

      assert.deepEqual(res1, { success: true, status: 'pending' });
      assert.deepEqual(res2, { success: true, status: 'pending' });

      // Exactly 1 update committed across the concurrent initial calls
      assert.equal(committedUpdates, 1, 'Exactly one transaction update committed across concurrent initial submissions');

      const snap = await driverRef.get();
      const data = snap.data();
      assert.equal(data.verificationStatus, 'pending');
      assert.ok(data.verificationDocs.submittedAt instanceof Timestamp);

      // Resubmit is idempotent without changing submittedAt or writing updates
      const originalTime = data.verificationDocs.submittedAt.toMillis();
      await new Promise(r => setTimeout(r, 20));
      const res3 = await submitDriverVerification.run({ auth: { uid: driverUid } });
      assert.deepEqual(res3, { success: true, status: 'pending' });
      assert.equal(committedUpdates, 1, 'No additional transaction update committed on idempotent resubmit');
      const snap2 = await driverRef.get();
      assert.equal(snap2.data().verificationDocs.submittedAt.toMillis(), originalTime);
    } finally {
      db.runTransaction = origRunTransaction;
    }
  });

  // ── 7. DELAYED COMMIT / SERVER TIMESTAMP RESOLUTION PROBE AGAINST REAL EMULATORS ──
  await t.test('Server Timestamp Resolution: delayed commit proves submittedAt and updatedAt are Firestore server timestamps, followed by zero-write idempotency', async () => {
    const driverUid = `int_delayed_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      name: 'Jasprit Bumrah',
      phone: '+919876543216',
      truckType: 'flatbed',
      vehicleNumber: 'MH 14 JB 1234',
      isOnDuty: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    // Hook runTransaction to intercept tx.update: capture hostTimeAtUpdate, then delay 1500ms AFTER tx.update but BEFORE commit (Finding 5C)
    const origRunTransaction = db.runTransaction.bind(db);
    const DELAY_MS = 1500;
    let hostTimeAtUpdate;

    db.runTransaction = async (callback) => {
      return await origRunTransaction(async (tx) => {
        const origUpdate = tx.update.bind(tx);
        tx.update = (ref, data, ...rest) => {
          hostTimeAtUpdate = Date.now();
          return origUpdate(ref, data, ...rest);
        };
        const res = await callback(tx);
        // Delay AFTER tx.update has constructed the write payload, but BEFORE transaction commits
        assert.ok(hostTimeAtUpdate, 'tx.update must have been invoked before delay');
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        return res;
      });
    };

    let result;
    try {
      result = await submitDriverVerification.run({ auth: { uid: driverUid } });
    } finally {
      db.runTransaction = origRunTransaction;
    }

    assert.deepEqual(result, { success: true, status: 'pending' });

    // Step 4: Read stored verificationDocs.submittedAt & updatedAt from Firestore emulator
    const snap1 = await driverRef.get();
    const data1 = snap1.data();

    // Step 5: Prove the stored values are genuine Firestore Timestamps generated at commit time
    assert.ok(data1.verificationDocs.submittedAt instanceof Timestamp, 'submittedAt must be genuine Timestamp');
    assert.ok(data1.updatedAt instanceof Timestamp, 'updatedAt must be genuine Timestamp');

    const submittedAtMs = data1.verificationDocs.submittedAt.toMillis();
    const updatedAtMs = data1.updatedAt.toMillis();

    assert.ok(
      submittedAtMs >= hostTimeAtUpdate + 1000,
      `submittedAt (${submittedAtMs}) must resolve to commit time (>= post-update ${hostTimeAtUpdate} + 1000ms), proving FieldValue.serverTimestamp() was resolved at commit time rather than precomputed host timestamp`
    );
    assert.ok(
      updatedAtMs >= hostTimeAtUpdate + 1000,
      `updatedAt (${updatedAtMs}) must resolve to commit time (>= post-update ${hostTimeAtUpdate} + 1000ms), proving FieldValue.serverTimestamp() was resolved at commit time`
    );

    // Step 6: Invoke pending submission again to prove zero-write idempotency
    await new Promise(resolve => setTimeout(resolve, 50));
    const result2 = await submitDriverVerification.run({ auth: { uid: driverUid } });
    assert.deepEqual(result2, { success: true, status: 'pending' });

    const snap2 = await driverRef.get();
    const data2 = snap2.data();

    assert.equal(data2.verificationStatus, 'pending');
    assert.equal(data2.verificationDocs.submittedAt.toMillis(), submittedAtMs, 'submittedAt must be strictly unchanged');
    assert.equal(data2.updatedAt.toMillis(), updatedAtMs, 'updatedAt must be strictly unchanged');
  });

  // ── 8. MALFORMED PERSISTED TIMESTAMPS IN REAL FIRESTORE EMULATOR ───────────
  await t.test('Malformed Timestamps: fake map timestamp in real Firestore is rejected with failed-precondition', async () => {
    const driverUid = `int_fakemap_${RUN_ID}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    // Store a fake map { seconds: 1, nanoseconds: 0 } into real Firestore emulator
    await driverRef.set({
      uid: driverUid,
      name: 'Fake Map Driver',
      phone: '+919876543217',
      truckType: 'hydraulic',
      vehicleNumber: 'MH 14 FM 1234',
      isOnDuty: false,
      createdAt: { seconds: 123456, nanoseconds: 0 },
      updatedAt: FieldValue.serverTimestamp(),
    });

    await bucket.file(`driver_verification/${driverUid}/id.jpg`).save(Buffer.from('id-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/rc.jpg`).save(Buffer.from('rc-bytes'), { contentType: 'image/jpeg' });
    await bucket.file(`driver_verification/${driverUid}/selfie.jpg`).save(Buffer.from('selfie-bytes'), { contentType: 'image/jpeg' });

    await assert.rejects(
      async () => {
        await submitDriverVerification.run({ auth: { uid: driverUid } });
      },
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /createdAt is missing or invalid Timestamp/);
        return true;
      }
    );

    const snap = await driverRef.get();
    assert.equal(snap.data().verificationStatus, undefined, 'Must perform ZERO writes to verificationStatus');
  });
});
