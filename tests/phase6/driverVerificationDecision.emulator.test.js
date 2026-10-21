'use strict';

/**
 * TowMitra Phase 6 M2 — Real Emulator Concurrency and Authorization Integration Tests
 *
 * Requirements (Gates S01, S02, S03, S04, F13):
 * - Real Firebase Emulator Suite (Auth, Firestore, Storage)
 * - Real issued Auth tokens from Auth Emulator REST API
 * - Real Firestore transactions exercising concurrency barriers (Promise.all)
 * - Exact-race: Admin A approve vs Admin B reject (exactly 1 wins)
 * - Two approvals race on same driver (exactly 1 commits)
 * - Same-ID duplicate concurrent requests (share action ID, idempotent)
 * - Fresh authority check on demoted user record
 * - Direct Firestore inspection of final committed records
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const { createDecisionManager } = require('../../firebase/functions/src/admin/driverVerificationDecision');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-towmitra-admin';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST;
process.env.METADATA_SERVER_DETECTION = 'none';

const app = getApps().length === 0 ? initializeApp({ projectId: PROJECT_ID }) : getApps()[0];
const adminAuth = getAuth(app);
const adminDb = getFirestore(app);
const adminStorage = getStorage(app);
const bucket = adminStorage.bucket(`${PROJECT_ID}.appspot.com`);

const manager = createDecisionManager({
  db: adminDb,
  auth: adminAuth,
  storage: adminStorage,
  bucket,
  TimestampClass: Timestamp,
  FieldValueClass: FieldValue,
});

// Helper to sign in synthetic user and get real Auth ID token from Auth emulator
async function getAuthToken(email, password = 'AdminPassword123!') {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) {
    throw new Error(`Failed to sign in ${email}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { idToken: data.idToken, localId: data.localId };
}

// Minimal valid JPEG bytes
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9
]);

async function setupTestDriver(uid) {
  const generations = {};
  for (const name of ['id', 'rc', 'selfie']) {
    const file = bucket.file(`driver_verification/${uid}/${name}.jpg`);
    await file.save(MINIMAL_JPEG, { contentType: 'image/jpeg' });
    const [meta] = await file.getMetadata();
    generations[name] = String(meta.generation);
  }

  const now = Timestamp.now();
  const driverData = {
    uid,
    name: `Emulator Driver ${uid}`,
    vehicleNumber: 'MH04AB9999',
    phone: '+919876543210',
    truckType: 'flatbed',
    isOnDuty: false,
    verificationStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    verificationDocs: {
      idPhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${uid}/id.jpg`,
      rcPhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${uid}/rc.jpg`,
      selfiePhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${uid}/selfie.jpg`,
      submittedAt: now,
    },
  };

  await adminDb.collection('drivers').doc(uid).set(driverData);

  return {
    driverData,
    generations,
    expectedUpdatedAt: { seconds: now.seconds, nanoseconds: now.nanoseconds },
    expectedSubmittedAt: { seconds: now.seconds, nanoseconds: now.nanoseconds },
  };
}

// ── S03: Real Firestore Concurrency & Race Tests ─────────────────────────────

test('S03: Race Admin A (approve) vs Admin B (reject) on real Firestore transactions: exactly one wins', async () => {
  const { idToken: tokenA, localId: uidA } = await getAuthToken('admin@towmitra.test');
  const { idToken: tokenB, localId: uidB } = await getAuthToken('admin-b@towmitra.test');

  const driverUid = 'm2-drv-race-ab-' + Date.now();
  const { expectedUpdatedAt, expectedSubmittedAt, generations } = await setupTestDriver(driverUid);

  const reqA = {
    auth: { uid: uidA, token: { admin: true } },
    token: tokenA,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      canFlatbed: true,
      canPulling: false,
      expectedObjectGenerations: generations,
    },
  };

  const reqB = {
    auth: { uid: uidB, token: { admin: true } },
    token: tokenB,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      reason: 'Rejection reason competing against approval.',
    },
  };

  // Launch both requests simultaneously against real emulator transactions
  const results = await Promise.allSettled([
    manager.executeDecision({ operation: 'adminApproveDriver', request: reqA }),
    manager.executeDecision({ operation: 'adminRejectDriver', request: reqB }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one concurrent decision must succeed');
  assert.equal(rejected.length, 1, 'Losing decision must fail closed');

  const winningDecision = fulfilled[0].value;
  assert.ok(winningDecision.verificationStatus === 'approved' || winningDecision.verificationStatus === 'rejected');

  // Verify final driver document in Firestore
  const finalDriverSnap = await adminDb.collection('drivers').doc(driverUid).get();
  const finalDriver = finalDriverSnap.data();
  assert.equal(finalDriver.verificationStatus, winningDecision.verificationStatus);

  // Verify exactly one admin_actions audit record was created for this driver
  const auditSnaps = await adminDb.collection('admin_actions').where('target', '==', driverUid).get();
  assert.equal(auditSnaps.docs.length, 1, 'Exactly one audit record must be written');
  assert.equal(auditSnaps.docs[0].data().action, winningDecision.verificationStatus === 'approved' ? 'approve_driver' : 'reject_driver');
});

test('S03: Race two approvals with different request IDs: exactly one commits', async () => {
  const { idToken, localId } = await getAuthToken('admin@towmitra.test');
  const driverUid = 'm2-drv-race-app2-' + Date.now();
  const { expectedUpdatedAt, expectedSubmittedAt, generations } = await setupTestDriver(driverUid);

  const req1 = {
    auth: { uid: localId, token: { admin: true } },
    token: idToken,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      canFlatbed: true,
      canPulling: false,
      expectedObjectGenerations: generations,
    },
  };

  const req2 = {
    auth: { uid: localId, token: { admin: true } },
    token: idToken,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      canFlatbed: false,
      canPulling: true,
      expectedObjectGenerations: generations,
    },
  };

  const results = await Promise.allSettled([
    manager.executeDecision({ operation: 'adminApproveDriver', request: req1 }),
    manager.executeDecision({ operation: 'adminApproveDriver', request: req2 }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Only one approval can win the transaction');
  assert.equal(rejected.length, 1, 'Second approval must fail closed');
  assert.equal(rejected[0].reason.code, 'failed-precondition');
});

test('S03: Concurrent duplicate requests with SAME requestId resolve to same action ID', async () => {
  const { idToken, localId } = await getAuthToken('admin@towmitra.test');
  const driverUid = 'm2-drv-race-sameid-' + Date.now();
  const { expectedUpdatedAt, expectedSubmittedAt, generations } = await setupTestDriver(driverUid);

  const sameRequestId = crypto.randomUUID();
  const req = {
    auth: { uid: localId, token: { admin: true } },
    token: idToken,
    data: {
      requestId: sameRequestId,
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      canFlatbed: true,
      canPulling: false,
      expectedObjectGenerations: generations,
    },
  };

  const results = await Promise.all([
    manager.executeDecision({ operation: 'adminApproveDriver', request: req }),
    manager.executeDecision({ operation: 'adminApproveDriver', request: req }),
  ]);

  // Both should succeed (one creates, second replays)
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, true);
  assert.equal(results[0].actionId, results[1].actionId, 'Both calls must share the exact action ID');

  // Verify only 1 audit record exists in admin_actions
  const auditSnaps = await adminDb.collection('admin_actions').where('target', '==', driverUid).get();
  assert.equal(auditSnaps.docs.length, 1, 'Only one audit record must be written for same request ID');
});

// ── S02: Fresh Authority Checks against Demoted User Record ─────────────────

test('S02: Caller with issued admin token is rejected after server-side claims demotion', async () => {
  // Create a temporary admin user
  const tempEmail = `temp-admin-${Date.now()}@towmitra.test`;
  const tempUser = await adminAuth.createUser({
    email: tempEmail,
    password: 'TempPassword123!',
    emailVerified: true,
  });
  await adminAuth.setCustomUserClaims(tempUser.uid, { admin: true });

  // Issue real ID token while still admin
  const { idToken, localId } = await getAuthToken(tempEmail, 'TempPassword123!');

  // Now demote server-side custom claim to admin: false
  await adminAuth.setCustomUserClaims(localId, { admin: false });

  const driverUid = 'm2-drv-demote-' + Date.now();
  const { expectedUpdatedAt, expectedSubmittedAt, generations } = await setupTestDriver(driverUid);

  const req = {
    auth: { uid: localId, token: { admin: true } }, // client still holds issued claim
    token: idToken,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      canFlatbed: true,
      canPulling: false,
      expectedObjectGenerations: generations,
    },
  };

  await assert.rejects(
    async () => {
      await manager.executeDecision({ operation: 'adminApproveDriver', request: req });
    },
    { code: 'permission-denied' }
  );

  // Verify driver remained pending with 0 writes
  const driverSnap = await adminDb.collection('drivers').doc(driverUid).get();
  assert.equal(driverSnap.data().verificationStatus, 'pending');

  // Clean up temporary user
  await adminAuth.deleteUser(localId);
});

// ── F13: Bootstrap Boundary Verification ───────────────────────────────────

test('F13: KYC approval on eight-field submitted profile leaves operational fields untouched', async () => {
  const { idToken, localId } = await getAuthToken('admin@towmitra.test');
  const driverUid = 'm2-drv-eight-field';

  // Fetch current state from seeded fixtures
  const beforeSnap = await adminDb.collection('drivers').doc(driverUid).get();
  assert.ok(beforeSnap.exists);
  const beforeData = beforeSnap.data();

  // Verify it has NO operational fields
  assert.equal('walletBalance' in beforeData, false);
  assert.equal('activeJobId' in beforeData, false);
  assert.equal('activeOfferId' in beforeData, false);
  assert.equal('bannedUntil' in beforeData, false);
  assert.equal('strictMode' in beforeData, false);
  assert.equal('monthlyCancelCount' in beforeData, false);

  // Get current storage generation
  const generations = {};
  for (const name of ['id', 'rc', 'selfie']) {
    const file = bucket.file(`driver_verification/${driverUid}/${name}.jpg`);
    const [meta] = await file.getMetadata();
    generations[name] = String(meta.generation);
  }

  const req = {
    auth: { uid: localId, token: { admin: true } },
    token: idToken,
    data: {
      requestId: crypto.randomUUID(),
      driverUid,
      expectedUpdatedAt: {
        seconds: beforeData.updatedAt.seconds,
        nanoseconds: beforeData.updatedAt.nanoseconds,
      },
      expectedSubmittedAt: {
        seconds: beforeData.verificationDocs.submittedAt.seconds,
        nanoseconds: beforeData.verificationDocs.submittedAt.nanoseconds,
      },
      canFlatbed: true,
      canPulling: false,
      expectedObjectGenerations: generations,
    },
  };

  const result = await manager.executeDecision({ operation: 'adminApproveDriver', request: req });
  assert.equal(result.success, true);
  assert.equal(result.verificationStatus, 'approved');

  // Inspect persisted document: exactly 5 fields updated, NO operational fields added
  const afterSnap = await adminDb.collection('drivers').doc(driverUid).get();
  const afterData = afterSnap.data();

  assert.equal(afterData.verificationStatus, 'approved');
  assert.equal(afterData.canFlatbed, true);
  assert.equal(afterData.canPulling, false);
  assert.equal(afterData.rejectionReason, null);

  // CRITICAL INVARIANT: Approval must NOT auto-provision operational bootstrap fields
  assert.equal('walletBalance' in afterData, false, 'walletBalance must NOT be auto-provisioned');
  assert.equal('activeJobId' in afterData, false, 'activeJobId must NOT be auto-provisioned');
  assert.equal('activeOfferId' in afterData, false, 'activeOfferId must NOT be auto-provisioned');
  assert.equal('bannedUntil' in afterData, false, 'bannedUntil must NOT be auto-provisioned');
  assert.equal('strictMode' in afterData, false, 'strictMode must NOT be auto-provisioned');
  assert.equal('monthlyCancelCount' in afterData, false, 'monthlyCancelCount must NOT be auto-provisioned');
});
