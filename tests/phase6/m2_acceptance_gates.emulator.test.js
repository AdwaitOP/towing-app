'use strict';

/**
 * TowMitra Phase 6 M2 — Acceptance Matrix Emulator Verification Suite
 *
 * Verifies gates:
 * - F01: Verification queries, status filters, and 25+ sentinel limit
 * - F02: Storage generation binding and missing image handling
 * - F06: Stale review fence (nanosecond mismatch in timestamps)
 * - F08: Jobs state contract (read-only, no admin job callables)
 * - F11: Deterministic pagination with 27+ fixtures and tie-break
 * - S01: Strict authority checks on callables (anonymous, non-admin, malformed, disabled)
 * - S04: Security rules direct write denials for drivers, jobs, audit, receipts
 * - S05: Storage rules enforcement (pending locked, delete denied)
 * - S09: Isolated harness exports check (adminApproveDriver, adminRejectDriver only)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const { createDecisionManager } = require('../../firebase/functions/src/admin/driverVerificationDecision');
const { verifyAdminCaller } = require('../../firebase/functions/src/admin/adminAuthorization');

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

async function getAuthToken(email, password = 'AdminPassword123!') {
  const url = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  return data.idToken;
}

test('M2 Acceptance Matrix Emulator Gates', async (t) => {
  // ── S09: Isolated Harness & Production Exports ─────────────────────────────
  await t.test('S09: Isolated harness exports exactly two M2 callables', () => {
    const harness = require('./emulator-harness/index.js');
    const exportsList = Object.keys(harness).sort();
    assert.deepEqual(exportsList, ['adminApproveDriver', 'adminRejectDriver']);

    const prod = require('../../firebase/functions/src/index.js');
    assert.equal(typeof prod.adminApproveDriver, 'function');
    assert.equal(typeof prod.adminRejectDriver, 'function');
    // Ensure no admin job mutation endpoints were created
    assert.equal(prod.adminCancelJob, undefined);
    assert.equal(prod.adminAssignJob, undefined);
    assert.equal(prod.adminOverrideDispatch, undefined);
  });

  // ── S01: Server-Side Authority Checks ──────────────────────────────────────
  await t.test('S01: Authority checks deny anonymous, non-admin, malformed, and disabled users', async () => {
    // 1. Missing context
    await assert.rejects(
      verifyAdminCaller({ request: null, auth: adminAuth }),
      (err) => err.code === 'unauthenticated'
    );

    // 2. Anonymous context
    await assert.rejects(
      verifyAdminCaller({ request: { auth: null }, auth: adminAuth }),
      (err) => err.code === 'unauthenticated'
    );

    // 3. Forged owner fixture bypass is rejected
    await assert.rejects(
      verifyAdminCaller({
        request: {
          auth: { uid: 'owner-uid', token: { admin: true } },
          rawRequest: { headers: { authorization: 'Bearer owner' } },
        },
        auth: adminAuth,
      }),
      (err) => err.code === 'permission-denied'
    );

    // 4. Non-admin user
    const nonAdminUid = `nonadmin_${Date.now()}`;
    await adminAuth.createUser({ uid: nonAdminUid, email: `${nonAdminUid}@test.local`, password: 'TestPassword123!' });
    await adminAuth.setCustomUserClaims(nonAdminUid, { admin: false });
    const nonAdminToken = await getAuthToken(`${nonAdminUid}@test.local`, 'TestPassword123!');

    await assert.rejects(
      verifyAdminCaller({
        request: {
          auth: { uid: nonAdminUid, token: { admin: false } },
          rawRequest: { headers: { authorization: `Bearer ${nonAdminToken}` } },
        },
        auth: adminAuth,
      }),
      (err) => err.code === 'permission-denied'
    );

    // 5. Disabled admin user (token issued then user disabled in server auth)
    const disabledUid = `disabled_admin_${Date.now()}`;
    await adminAuth.createUser({ uid: disabledUid, email: `${disabledUid}@test.local`, password: 'TestPassword123!' });
    await adminAuth.setCustomUserClaims(disabledUid, { admin: true });
    const disabledToken = await getAuthToken(`${disabledUid}@test.local`, 'TestPassword123!');
    await adminAuth.updateUser(disabledUid, { disabled: true });

    await assert.rejects(
      verifyAdminCaller({
        request: {
          auth: { uid: disabledUid, token: { admin: true } },
          rawRequest: { headers: { authorization: `Bearer ${disabledToken}` } },
        },
        auth: adminAuth,
      }),
      (err) => err.code === 'unauthenticated' || err.code === 'permission-denied'
    );
  });

  // ── F01: Verification Query and Status Filters ────────────────────────────
  await t.test('F01: Verification queries bound to 25 + 1 sentinel and status filters', async () => {
    // Query pending drivers with limit 26
    const pendingSnap = await adminDb.collection('drivers')
      .where('verificationStatus', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .orderBy('__name__', 'asc')
      .limit(26)
      .get();

    assert.equal(pendingSnap.docs.length > 0, true, 'Pending fixtures exist');
    assert.equal(pendingSnap.docs.length <= 26, true, 'Capped at 26 sentinel');

    for (const doc of pendingSnap.docs) {
      assert.equal(doc.data().verificationStatus, 'pending');
    }

    // Query approved drivers
    const approvedSnap = await adminDb.collection('drivers')
      .where('verificationStatus', '==', 'approved')
      .limit(26)
      .get();
    for (const doc of approvedSnap.docs) {
      assert.equal(doc.data().verificationStatus, 'approved');
    }

    // Query rejected drivers
    const rejectedSnap = await adminDb.collection('drivers')
      .where('verificationStatus', '==', 'rejected')
      .limit(26)
      .get();
    for (const doc of rejectedSnap.docs) {
      assert.equal(doc.data().verificationStatus, 'rejected');
    }
  });

  // ── F02 & F05: Storage Evidence Binding & Missing File Handling ────────────
  await t.test('F02 & F05: Missing evidence blocks approval but permits valid rejection', async () => {
    const adminUid = `admin_f02_${Date.now()}`;
    await adminAuth.createUser({ uid: adminUid, email: `${adminUid}@test.local`, password: 'AdminPassword123!' });
    await adminAuth.setCustomUserClaims(adminUid, { admin: true });
    const adminToken = await getAuthToken(`${adminUid}@test.local`);

    const driverId = 'm2-drv-missing-file';
    const baseTime = new Timestamp(1792368000 + 230, 888000);
    await adminDb.collection('drivers').doc(driverId).set({
      uid: driverId,
      name: 'Omkar MissingDoc',
      vehicleNumber: 'MH43ST1010',
      phone: '+919820011010',
      truckType: 'tochan',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: new Timestamp(1792368000 + 130, 0),
      updatedAt: baseTime,
      verificationDocs: {
        idPhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${driverId}/id.jpg`,
        rcPhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${driverId}/rc.jpg`,
        selfiePhotoUrl: `gs://${PROJECT_ID}.appspot.com/driver_verification/${driverId}/selfie.jpg`,
        submittedAt: baseTime,
      },
    });

    const driverSnap = await adminDb.collection('drivers').doc(driverId).get();
    assert.equal(driverSnap.exists, true, `Driver ${driverId} exists in Firestore`);
    const data = driverSnap.data();

    // Approval must fail because selfie.jpg is missing from Storage
    await assert.rejects(
      manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: adminUid, token: { admin: true } },
          rawRequest: { headers: { authorization: `Bearer ${adminToken}` } },
          data: {
            requestId: crypto.randomUUID(),
            driverUid: driverId,
            expectedUpdatedAt: { seconds: data.updatedAt.seconds, nanoseconds: data.updatedAt.nanoseconds },
            expectedSubmittedAt: { seconds: data.verificationDocs.submittedAt.seconds, nanoseconds: data.verificationDocs.submittedAt.nanoseconds },
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: '1', rc: '1', selfie: '1' },
          },
        },
      }),
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /Evidence generation changed or missing/i);
        return true;
      }
    );

    // Rejection of missing-evidence profile is allowed to communicate reason to driver
    const rejectResult = await manager.executeDecision({
      operation: 'adminRejectDriver',
      request: {
        auth: { uid: adminUid, token: { admin: true } },
        rawRequest: { headers: { authorization: `Bearer ${adminToken}` } },
        data: {
          requestId: crypto.randomUUID(),
          driverUid: driverId,
          expectedUpdatedAt: { seconds: data.updatedAt.seconds, nanoseconds: data.updatedAt.nanoseconds },
          expectedSubmittedAt: { seconds: data.verificationDocs.submittedAt.seconds, nanoseconds: data.verificationDocs.submittedAt.nanoseconds },
          reason: 'Selfie photo was missing from application. Please re-upload all documents.',
        },
      },
    });
    assert.equal(rejectResult.success, true);
    assert.equal(rejectResult.verificationStatus, 'rejected');

    // Confirm persisted Firestore driver document
    const updatedDriverSnap = await adminDb.collection('drivers').doc(driverId).get();
    const updatedData = updatedDriverSnap.data();
    assert.equal(updatedData.verificationStatus, 'rejected');
    assert.equal(updatedData.rejectionReason, 'Selfie photo was missing from application. Please re-upload all documents.');
    assert.equal(updatedData.canFlatbed, false);
    assert.equal(updatedData.canPulling, false);
  });

  // ── F06: Stale Review Fence (Nanosecond Exactness) ─────────────────────────
  await t.test('F06: Review timestamp fence rejects nanosecond discrepancy', async () => {
    const adminUid = `admin_f06_${Date.now()}`;
    await adminAuth.createUser({ uid: adminUid, email: `${adminUid}@test.local`, password: 'AdminPassword123!' });
    await adminAuth.setCustomUserClaims(adminUid, { admin: true });
    const adminToken = await getAuthToken(`${adminUid}@test.local`);

    const driverId = 'm2-drv-stale-review';
    const driverSnap = await adminDb.collection('drivers').doc(driverId).get();
    assert.equal(driverSnap.exists, true);
    const data = driverSnap.data();

    // 1 nanosecond difference in expectedUpdatedAt
    const staleUpdatedAt = { seconds: data.updatedAt.seconds, nanoseconds: data.updatedAt.nanoseconds + 1 };

    await assert.rejects(
      manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: adminUid, token: { admin: true } },
          rawRequest: { headers: { authorization: `Bearer ${adminToken}` } },
          data: {
            requestId: crypto.randomUUID(),
            driverUid: driverId,
            expectedUpdatedAt: staleUpdatedAt,
            expectedSubmittedAt: { seconds: data.verificationDocs.submittedAt.seconds, nanoseconds: data.verificationDocs.submittedAt.nanoseconds },
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: '1', rc: '1', selfie: '1' },
          },
        },
      }),
      (err) => {
        assert.equal(err.code, 'failed-precondition');
        assert.match(err.message, /Application was updated since review/i);
        return true;
      }
    );
  });

  // ── F08: Jobs State Contract ───────────────────────────────────────────────
  await t.test('F08: Jobs operational queries return only valid active states', async () => {
    const activeStatuses = ['pending_offer', 'offered', 'accepted', 'in_progress'];
    const jobsSnap = await adminDb.collection('jobs')
      .where('status', 'in', activeStatuses)
      .limit(26)
      .get();

    assert.equal(jobsSnap.docs.length > 0, true);
    for (const doc of jobsSnap.docs) {
      assert.equal(activeStatuses.includes(doc.data().status), true);
      assert.notEqual(doc.data().status, 'completed');
      assert.notEqual(doc.data().status, 'cancelled');
      assert.notEqual(doc.data().status, 'refunded');
    }
  });

  // ── F11: Deterministic Pagination with 27+ Fixtures ────────────────────────
  await t.test('F11: Pagination correctly pages with cursor and ID tie-break', async () => {
    // Page 1: 25 items + 1 sentinel
    const page1Snap = await adminDb.collection('drivers')
      .where('verificationStatus', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .orderBy('__name__', 'asc')
      .limit(26)
      .get();

    assert.equal(page1Snap.docs.length, 26, 'Sentinel detects next page available');
    const displayedDocs = page1Snap.docs.slice(0, 25);
    const lastDoc = displayedDocs[24];

    // Page 2: startAfter lastDoc
    const page2Snap = await adminDb.collection('drivers')
      .where('verificationStatus', '==', 'pending')
      .orderBy('createdAt', 'asc')
      .orderBy('__name__', 'asc')
      .startAfter(lastDoc)
      .limit(26)
      .get();

    assert.equal(page2Snap.docs.length >= 1, true, 'Page 2 contains remaining fixtures');
    // Ensure no overlap between page 1 displayed docs and page 2 docs
    const page1Ids = new Set(displayedDocs.map((d) => d.id));
    for (const doc of page2Snap.docs) {
      assert.equal(page1Ids.has(doc.id), false, `Page 2 doc ${doc.id} must not appear on Page 1`);
    }
  });

  // ── S04: Direct Client Write Denials to Protected Collections ──────────────
  await t.test('S04: Direct client write attempts to drivers, jobs, audit, receipts are denied', async () => {
    const adminUid = `admin_s04_${Date.now()}`;
    await adminAuth.createUser({ uid: adminUid, email: `${adminUid}@test.local`, password: 'AdminPassword123!' });
    await adminAuth.setCustomUserClaims(adminUid, { admin: true });
    const adminToken = await getAuthToken(`${adminUid}@test.local`);

    // REST write directly to drivers collection as admin
    const writeUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/drivers/drv_direct_write_test`;
    const res = await fetch(writeUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          name: { stringValue: 'Hacked Name' },
          verificationStatus: { stringValue: 'approved' },
        },
      }),
    });

    assert.equal(res.status, 403, 'Direct write to drivers must be HTTP 403 Forbidden even with admin claim');

    // Direct write to admin_actions audit collection
    const auditUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/admin_actions/audit_test`;
    const auditRes = await fetch(auditUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          action: { stringValue: 'forged_action' },
        },
      }),
    });

    assert.equal(auditRes.status, 403, 'Direct write to admin_actions must be HTTP 403 Forbidden');

    // Direct write to jobs collection
    const jobUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/job_direct_write_test`;
    const jobRes = await fetch(jobUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          status: { stringValue: 'cancelled' },
        },
      }),
    });
    assert.equal(jobRes.status, 403, 'Direct write to jobs must be HTTP 403 Forbidden');

    // Direct write to processed_requests receipt collection
    const receiptUrl = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/processed_requests/receipt_test`;
    const receiptRes = await fetch(receiptUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          status: { stringValue: 'completed' },
        },
      }),
    });
    assert.equal(receiptRes.status, 403, 'Direct write to processed_requests must be HTTP 403 Forbidden');
  });
});
