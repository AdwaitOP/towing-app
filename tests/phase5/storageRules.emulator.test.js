'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'towing-phase5-storage';
const BUCKET = `${PROJECT_ID}.appspot.com`;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function authToken(uid, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: uid,
    user_id: uid,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    iat: now,
    exp: now + 3600,
    firebase: { sign_in_provider: 'custom', identities: {} },
    ...claims,
  }));
  return `${header}.${payload}.`;
}

async function setDriverDoc(driverId, fields = {}) {
  const url = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/drivers/${driverId}`;
  const document = {
    fields: {},
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) document.fields[k] = { nullValue: null };
    else if (typeof v === 'string') document.fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') document.fields[k] = { booleanValue: v };
    else if (typeof v === 'number') document.fields[k] = { integerValue: String(v) };
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer owner` },
    body: JSON.stringify(document),
  });
  return res.status;
}

async function uploadFile({ driverId, filename, token, contentType = 'image/jpeg', body = 'fake-image-bytes' } = {}) {
  const objectPath = encodeURIComponent(`driver_verification/${driverId}/${filename}`);
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${objectPath}`;
  const headers = {
    'Content-Type': contentType,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  });
  return res.status;
}

async function readFile({ driverId, filename, token } = {}) {
  const objectPath = encodeURIComponent(`driver_verification/${driverId}/${filename}`);
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${objectPath}?alt=media`;
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: 'GET',
    headers,
  });
  return res.status;
}

async function deleteFile({ driverId, filename, token } = {}) {
  const objectPath = encodeURIComponent(`driver_verification/${driverId}/${filename}`);
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/${objectPath}`;
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: 'DELETE',
    headers,
  });
  return res.status;
}

const RUN = randomUUID().slice(0, 8);
const DRIVER_MISSING = `driver_missing_${RUN}`;
const DRIVER_ABSENT_STATUS = `driver_absent_${RUN}`;
const DRIVER_NULL_STATUS = `driver_null_${RUN}`;
const DRIVER_REJECTED = `driver_rej_${RUN}`;
const DRIVER_PENDING = `driver_pend_${RUN}`;
const DRIVER_APPROVED = `driver_appr_${RUN}`;
const DRIVER_MALFORMED_STATUS = `driver_malformed_${RUN}`;
const DRIVER_B = `driver_b_${RUN}`;

test('Storage Security Rules: Full State-Aware Matrix & Real Firestore Lookup Proof', async (t) => {
  // 1. Seed real Firestore driver documents (DO NOT seed DRIVER_MISSING)
  await setDriverDoc(DRIVER_ABSENT_STATUS, { uid: DRIVER_ABSENT_STATUS, name: 'Driver Absent Status' });
  await setDriverDoc(DRIVER_NULL_STATUS, { uid: DRIVER_NULL_STATUS, name: 'Driver Null Status', verificationStatus: null });
  await setDriverDoc(DRIVER_REJECTED, { uid: DRIVER_REJECTED, name: 'Driver Rej', verificationStatus: 'rejected' });
  await setDriverDoc(DRIVER_PENDING, { uid: DRIVER_PENDING, name: 'Driver Pend', verificationStatus: 'pending' });
  await setDriverDoc(DRIVER_APPROVED, { uid: DRIVER_APPROVED, name: 'Driver Appr', verificationStatus: 'approved' });
  await setDriverDoc(DRIVER_MALFORMED_STATUS, { uid: DRIVER_MALFORMED_STATUS, name: 'Driver Malformed', verificationStatus: 'unknown_status' });
  await setDriverDoc(DRIVER_B, { uid: DRIVER_B, name: 'Driver B' });

  // -- GROUP 0: MISSING DRIVER DOCUMENT (FINDING 1) --------------------------
  await t.test('MISSING DRIVER DOC: unseeded driver UID fails closed (403 denied)', async () => {
    const token = authToken(DRIVER_MISSING);
    const status = await uploadFile({ driverId: DRIVER_MISSING, filename: 'id.jpg', token });
    assert.equal(status, 403, `Expected 403 when driver document is missing in Firestore, got ${status}`);
  });

  // -- GROUP 1: UNAUTHENTICATED ----------------------------------------------
  await t.test('UNAUTHENTICATED: read, create, update, delete denied', async () => {
    const createStatus = await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token: null });
    assert.ok(createStatus === 401 || createStatus === 403, `Expected 401 or 403 for unauth create, got ${createStatus}`);

    const readStatus = await readFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token: null });
    assert.ok(readStatus === 401 || readStatus === 403, `Expected 401 or 403 for unauth read, got ${readStatus}`);

    const deleteStatus = await deleteFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token: null });
    assert.ok(deleteStatus === 401 || deleteStatus === 403, `Expected 401 or 403 for unauth delete, got ${deleteStatus}`);
  });

  // -- GROUP 2: CROSS DRIVER ------------------------------------------------
  await t.test('CROSS DRIVER: Driver A actions on Driver B denied', async () => {
    // Seed Driver B file first
    const tokenB = authToken(DRIVER_B);
    assert.equal(await uploadFile({ driverId: DRIVER_B, filename: 'id.jpg', token: tokenB }), 200);

    const tokenA = authToken(DRIVER_ABSENT_STATUS);
    // Create Driver B's file
    assert.equal(await uploadFile({ driverId: DRIVER_B, filename: 'rc.jpg', token: tokenA }), 403);
    // Read Driver B's file
    assert.equal(await readFile({ driverId: DRIVER_B, filename: 'id.jpg', token: tokenA }), 403);
    // Delete Driver B's file
    assert.equal(await deleteFile({ driverId: DRIVER_B, filename: 'id.jpg', token: tokenA }), 403);
  });

  // -- GROUP 3: UNSUBMITTED / ABSENT STATUS STATE ---------------------------
  await t.test('UNSUBMITTED (absent status): own id.jpg, rc.jpg, selfie.jpg allowed; read allowed; update allowed', async () => {
    const token = authToken(DRIVER_ABSENT_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token }), 200);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'rc.jpg', token }), 200);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'selfie.jpg', token }), 200);

    // Read own file allowed
    assert.equal(await readFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token }), 200);

    // Update unsubmitted file allowed
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token, body: 'updated-id-bytes' }), 200);
  });

  // -- GROUP 3B: NULL STATUS STATE ------------------------------------------
  await t.test('UNSUBMITTED (null status): own id.jpg allowed; update allowed', async () => {
    const token = authToken(DRIVER_NULL_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_NULL_STATUS, filename: 'id.jpg', token }), 200);
    assert.equal(await uploadFile({ driverId: DRIVER_NULL_STATUS, filename: 'id.jpg', token, body: 'updated-null-bytes' }), 200);
    assert.equal(await readFile({ driverId: DRIVER_NULL_STATUS, filename: 'id.jpg', token }), 200);
  });

  // -- GROUP 4: REJECTED STATE ----------------------------------------------
  await t.test('REJECTED: own replacements allowed; read allowed; update allowed', async () => {
    const token = authToken(DRIVER_REJECTED);
    assert.equal(await uploadFile({ driverId: DRIVER_REJECTED, filename: 'id.jpg', token }), 200);
    assert.equal(await uploadFile({ driverId: DRIVER_REJECTED, filename: 'rc.jpg', token }), 200);
    assert.equal(await uploadFile({ driverId: DRIVER_REJECTED, filename: 'selfie.jpg', token }), 200);

    // Read allowed
    assert.equal(await readFile({ driverId: DRIVER_REJECTED, filename: 'id.jpg', token }), 200);

    // Update allowed in rejected state
    assert.equal(await uploadFile({ driverId: DRIVER_REJECTED, filename: 'id.jpg', token, body: 're-uploaded-bytes' }), 200);
  });

  // -- GROUP 5: PENDING STATE -----------------------------------------------
  await t.test('PENDING: creates denied; seeded updates denied; read allowed', async () => {
    const uidPendingUpdate = `driver_pend_up_${RUN}`;
    await setDriverDoc(uidPendingUpdate, { uid: uidPendingUpdate, name: 'Pending Update Driver' });
    const token = authToken(uidPendingUpdate);
    assert.equal(await uploadFile({ driverId: uidPendingUpdate, filename: 'id.jpg', token }), 200);

    // Flip to pending
    await setDriverDoc(uidPendingUpdate, { uid: uidPendingUpdate, verificationStatus: 'pending' });

    // Attempt create of new doc
    assert.equal(await uploadFile({ driverId: uidPendingUpdate, filename: 'rc.jpg', token }), 403);

    // Attempt UPDATE of existing seeded doc
    assert.equal(await uploadFile({ driverId: uidPendingUpdate, filename: 'id.jpg', token, body: 'overwriting-attempt' }), 403);

    // Read seeded file remains allowed for owner
    assert.equal(await readFile({ driverId: uidPendingUpdate, filename: 'id.jpg', token }), 200);
  });

  // -- GROUP 6: APPROVED STATE ----------------------------------------------
  await t.test('APPROVED: creates denied; seeded updates denied; read allowed', async () => {
    const uidApprUpdate = `driver_appr_up_${RUN}`;
    await setDriverDoc(uidApprUpdate, { uid: uidApprUpdate, name: 'Appr Update Driver' });
    const token = authToken(uidApprUpdate);
    assert.equal(await uploadFile({ driverId: uidApprUpdate, filename: 'id.jpg', token }), 200);

    // Flip to approved
    await setDriverDoc(uidApprUpdate, { uid: uidApprUpdate, verificationStatus: 'approved' });

    // Attempt create of new doc
    assert.equal(await uploadFile({ driverId: uidApprUpdate, filename: 'rc.jpg', token }), 403);

    // Attempt UPDATE of existing seeded doc
    assert.equal(await uploadFile({ driverId: uidApprUpdate, filename: 'id.jpg', token, body: 'overwriting-attempt' }), 403);

    // Read seeded file remains allowed for owner
    assert.equal(await readFile({ driverId: uidApprUpdate, filename: 'id.jpg', token }), 200);
  });

  // -- GROUP 6B: MALFORMED VERIFICATION STATUS ------------------------------
  await t.test('MALFORMED STATUS: arbitrary status fails closed (403 denied)', async () => {
    const token = authToken(DRIVER_MALFORMED_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_MALFORMED_STATUS, filename: 'id.jpg', token }), 403);
  });

  // -- GROUP 7: FILENAME RESTRICTIONS ---------------------------------------
  await t.test('FILENAME: hack.exe, id.png, random.jpg denied', async () => {
    const token = authToken(DRIVER_ABSENT_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'hack.exe', token }), 403);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.png', token }), 403);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'random.jpg', token }), 403);
  });

  // -- GROUP 8: CONTENT TYPE RESTRICTIONS -----------------------------------
  await t.test('CONTENT TYPE: text/plain, application/octet-stream denied', async () => {
    const token = authToken(DRIVER_ABSENT_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token, contentType: 'text/plain' }), 403);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token, contentType: 'application/octet-stream' }), 403);
  });

  // -- GROUP 8B: POSITIVE MIME COMPATIBILITY --------------------------------
  await t.test('MIME COMPATIBILITY: non-jpeg image/* (image/png) accepted when filename is allowlisted .jpg', async () => {
    const token = authToken(DRIVER_ABSENT_STATUS);
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token, contentType: 'image/png' }), 200);
  });

  // -- GROUP 9: SIZE RESTRICTIONS -------------------------------------------
  await t.test('SIZE: payload > 10 MB denied', async () => {
    const token = authToken(DRIVER_ABSENT_STATUS);
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024); // 10MB + 1KB
    assert.equal(await uploadFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token, body: oversizedBuffer }), 403);
  });

  // -- GROUP 10: DELETE RESTRICTIONS IN ALL 6 VERIFICATION STATES ------------
  await t.test('DELETE: explicitly denied in EVERY verification state on existing seeded objects (absent, null, rejected, pending, approved, malformed)', async () => {
    // 1. Absent status (unsubmitted)
    assert.equal(await deleteFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token: authToken(DRIVER_ABSENT_STATUS) }), 403);

    // 2. Null status (unsubmitted)
    assert.equal(await deleteFile({ driverId: DRIVER_NULL_STATUS, filename: 'id.jpg', token: authToken(DRIVER_NULL_STATUS) }), 403);

    // 3. Rejected status
    assert.equal(await deleteFile({ driverId: DRIVER_REJECTED, filename: 'id.jpg', token: authToken(DRIVER_REJECTED) }), 403);

    // 4. Pending status: seed object as unsubmitted, flip to pending, then attempt delete
    const uidPendingDel = `driver_del_pend_${RUN}`;
    await setDriverDoc(uidPendingDel, { uid: uidPendingDel, name: 'Pending Delete Driver' });
    assert.equal(await uploadFile({ driverId: uidPendingDel, filename: 'id.jpg', token: authToken(uidPendingDel) }), 200);
    await setDriverDoc(uidPendingDel, { uid: uidPendingDel, verificationStatus: 'pending' });
    assert.equal(await deleteFile({ driverId: uidPendingDel, filename: 'id.jpg', token: authToken(uidPendingDel) }), 403);

    // 5. Approved status: seed object as unsubmitted, flip to approved, then attempt delete
    const uidApprDel = `driver_del_appr_${RUN}`;
    await setDriverDoc(uidApprDel, { uid: uidApprDel, name: 'Approved Delete Driver' });
    assert.equal(await uploadFile({ driverId: uidApprDel, filename: 'id.jpg', token: authToken(uidApprDel) }), 200);
    await setDriverDoc(uidApprDel, { uid: uidApprDel, verificationStatus: 'approved' });
    assert.equal(await deleteFile({ driverId: uidApprDel, filename: 'id.jpg', token: authToken(uidApprDel) }), 403);

    // 6. Malformed status: seed object as unsubmitted, flip to malformed status, then attempt delete
    const uidMalformedDel = `driver_del_mal_${RUN}`;
    await setDriverDoc(uidMalformedDel, { uid: uidMalformedDel, name: 'Malformed Delete Driver' });
    assert.equal(await uploadFile({ driverId: uidMalformedDel, filename: 'id.jpg', token: authToken(uidMalformedDel) }), 200);
    await setDriverDoc(uidMalformedDel, { uid: uidMalformedDel, verificationStatus: 'corrupted_state' });
    assert.equal(await deleteFile({ driverId: uidMalformedDel, filename: 'id.jpg', token: authToken(uidMalformedDel) }), 403);
  });

  // -- GROUP 11: ADMIN ACCESS -----------------------------------------------
  await t.test('ADMIN: read allowed on any driver documents', async () => {
    const adminToken = authToken('admin_user_1', { admin: true });
    assert.equal(await readFile({ driverId: DRIVER_ABSENT_STATUS, filename: 'id.jpg', token: adminToken }), 200);
    assert.equal(await readFile({ driverId: DRIVER_REJECTED, filename: 'id.jpg', token: adminToken }), 200);
  });
});
