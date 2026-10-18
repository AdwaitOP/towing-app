#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Firestore Security Rules Integration Test (Section 7, M1-M, D4, D10)
 *
 * Requirements:
 * - Strict loopback & project validation via validate-endpoint.mjs (D4)
 * - Required environment variables (no fallback defaults for missing env) (D4)
 * - Real Auth-issued tokens from Firebase Auth Emulator REST endpoint (D10)
 * - Strict HTTP 200 + payload assertion for allowed reads (rejects 404/500/401) (D10)
 * - Strict HTTP 403 (Permission Denied) for unauthorized operations (D10)
 * - Tests claim variants: true, missing, false, string, number, null, object, array (D10)
 * - Tests token refresh lifecycle (older token validity, fresh demoted denial, fresh promoted allowance) (D10)
 * - Tests protected client writes remain rejected (HTTP 403) for all users (D10)
 */

import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

// Strict Fail-Closed Environment Checks (D4)
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const firestoreHost = validateEmulatorHost('FIRESTORE_EMULATOR_HOST', process.env.FIRESTORE_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

const app = getApps().length === 0 ? initializeApp({ projectId }) : getApps()[0];
const adminAuth = getAuth(app);
const adminDb = getFirestore(app);

const BASE_URL = `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/`;
const PASSWORD = 'RulesPassword123!';

async function firestoreRequest(docPath, token = null, method = 'GET', body = null) {
  const url = `${BASE_URL}${docPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty response
  }
  return { status: res.status, ok: res.ok, data };
}

function assertConfigPayload(res) {
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.strictEqual(
    res.data?.name,
    `projects/${projectId}/databases/(default)/documents/dispatch_config/main`,
    `Document identity mismatch: expected exact projects/${projectId}/databases/(default)/documents/dispatch_config/main, got ${res.data?.name}`
  );
  assert.ok(res.data?.fields && Object.keys(res.data.fields).length > 0, 'Document fields must not be empty');
  const version = res.data.fields.version?.stringValue ?? res.data.fields.version;
  assert.equal(version, '1.0.0-rules-test', `Expected version 1.0.0-rules-test, got ${version}`);
  const minFee = res.data.fields.minTowingFee?.integerValue ?? res.data.fields.minTowingFee;
  assert.equal(String(minFee), '500', `Expected minTowingFee 500, got ${minFee}`);
}

function assertJobPayload(res) {
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.strictEqual(
    res.data?.name,
    `projects/${projectId}/databases/(default)/documents/jobs/job-rules-test`,
    `Document identity mismatch: expected exact projects/${projectId}/databases/(default)/documents/jobs/job-rules-test, got ${res.data?.name}`
  );
  assert.ok(res.data?.fields && Object.keys(res.data.fields).length > 0, 'Document fields must not be empty');
  const status = res.data.fields.status?.stringValue ?? res.data.fields.status;
  assert.equal(status, 'DISPATCHED', `Expected status DISPATCHED, got ${status}`);
  const phone = res.data.fields.customerPhone?.stringValue ?? res.data.fields.customerPhone;
  assert.equal(phone, '+919999999999', `Expected customerPhone +919999999999, got ${phone}`);
}

function assertDriverPayload(res) {
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.strictEqual(
    res.data?.name,
    `projects/${projectId}/databases/(default)/documents/drivers/driver-rules-test-1`,
    `Document identity mismatch: expected exact projects/${projectId}/databases/(default)/documents/drivers/driver-rules-test-1, got ${res.data?.name}`
  );
  assert.ok(res.data?.fields && Object.keys(res.data.fields).length > 0, 'Document fields must not be empty');
  const name = res.data.fields.name?.stringValue ?? res.data.fields.name;
  assert.equal(name, 'Driver One', `Expected name Driver One, got ${name}`);
}

async function signInUser(email) {
  const url = `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key-for-emulator`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  assert.equal(res.status, 200, `Sign-in failed for ${email}: ${res.statusText}`);
  return res.json();
}

async function refreshToken(token) {
  const url = `http://${authHost}/securetoken.googleapis.com/v1/token?key=fake-api-key-for-emulator`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),
  });
  assert.equal(res.status, 200, `Token refresh failed: ${res.statusText}`);
  return res.json();
}

async function ensureUser(email, claims) {
  let user;
  try {
    user = await adminAuth.getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      user = await adminAuth.createUser({ email, password: PASSWORD });
    } else {
      throw err;
    }
  }
  await adminAuth.setCustomUserClaims(user.uid, claims);
  return user;
}

let passed = 0;
let total = 0;

async function check(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`\x1b[32m  ✓ PASS\x1b[0m ${name}`);
  } catch (err) {
    console.error(`\x1b[31m  ✗ FAIL\x1b[0m ${name}: ${err.message}`);
    throw err;
  }
}

async function run() {
  console.log('\n🔒 TowMitra Rules Integration Test (Auth-Issued Tokens & Strict Proof)');
  console.log(`   Project:   ${projectId}`);
  console.log(`   Firestore: ${firestoreHost}`);
  console.log(`   Auth:      ${authHost}\n`);

  // 1. Seed Required Documents using Admin SDK
  console.log('📦 Seeding test documents...');
  await adminDb.doc('dispatch_config/main').set({
    version: '1.0.0-rules-test',
    updatedAt: new Date().toISOString(),
    minTowingFee: 500,
  });

  await adminDb.doc('jobs/job-rules-test').set({
    status: 'DISPATCHED',
    customerPhone: '+919999999999',
    driverId: 'driver-rules-test-1',
  });

  await adminDb.doc('wallet_entries/wallet-rules-test').set({
    driverId: 'driver-rules-test-1',
    balance: 1500,
  });

  await adminDb.doc('drivers/driver-rules-test-1').set({
    name: 'Driver One',
    status: 'ACTIVE',
  });

  await adminDb.doc('drivers/driver-rules-test-2').set({
    name: 'Driver Two',
    status: 'ACTIVE',
  });

  // 2. Setup Test Accounts & Claims
  console.log('👤 Configuring synthetic test users with Auth-issued tokens...');
  const claimVariants = [
    ['true', { admin: true }],
    ['missing', {}],
    ['false', { admin: false }],
    ['string', { admin: 'true' }],
    ['number', { admin: 1 }],
    ['null', { admin: null }],
    ['object', { admin: {} }],
    ['array', { admin: [] }],
  ];

  const userTokens = {};
  for (const [variant, claims] of claimVariants) {
    const email = `test-${variant}@towmitra.test`;
    const user = await ensureUser(email, { ...claims, fixture: 'rules-test' });
    const tokens = await signInUser(email);
    userTokens[variant] = { user, tokens };
  }

  // Also setup a driver account whose UID matches driver-rules-test-1
  let driverUser;
  try {
    driverUser = await adminAuth.getUser('driver-rules-test-1');
  } catch {
    driverUser = await adminAuth.createUser({
      uid: 'driver-rules-test-1',
      email: 'driver-1@towmitra.test',
      password: PASSWORD,
    });
  }
  const driverTokens = await signInUser('driver-1@towmitra.test');

  // And driver 2
  let driver2User;
  try {
    driver2User = await adminAuth.getUser('driver-rules-test-2');
  } catch {
    driver2User = await adminAuth.createUser({
      uid: 'driver-rules-test-2',
      email: 'driver-2@towmitra.test',
      password: PASSWORD,
    });
  }
  const driver2Tokens = await signInUser('driver-2@towmitra.test');

  console.log('\n🧪 Running Rule Verifications:');

  // A. Admin Proof: dispatch_config/main read
  for (const [variant] of claimVariants) {
    const isPermitted = variant === 'true';
    await check(
      `dispatch_config/main read with claim [admin: ${variant}] -> ${isPermitted ? '200 OK with payload' : '403 Forbidden'}`,
      async () => {
        const res = await firestoreRequest('dispatch_config/main', userTokens[variant].tokens.idToken);
        if (isPermitted) {
          assertConfigPayload(res);
        } else {
          assert.equal(res.status, 403, `Expected 403 for admin: ${variant}, got ${res.status}`);
        }
      }
    );
  }

  // B. Unauthenticated read of dispatch_config/main
  await check('dispatch_config/main read unauthenticated -> 403 Forbidden', async () => {
    const res = await firestoreRequest('dispatch_config/main');
    assert.equal(res.status, 403, `Expected 403 for unauthenticated read, got ${res.status}`);
  });

  // C. Protected client writes rejected for ALL roles (including admin: true)
  for (const [variant] of claimVariants) {
    await check(
      `dispatch_config/main write rejected for [admin: ${variant}] -> 403 Forbidden`,
      async () => {
        const res = await firestoreRequest(
          'dispatch_config/main',
          userTokens[variant].tokens.idToken,
          'PATCH',
          { fields: { maliciousWrite: { booleanValue: true } } }
        );
        assert.equal(res.status, 403, `Client write to dispatch_config must be rejected (403), got ${res.status}`);
      }
    );
  }

  // D. Raw job collection read: admin: true allowed (200), non-admin rejected (403)
  await check('jobs/job-rules-test read by admin -> 200 OK with payload', async () => {
    const res = await firestoreRequest('jobs/job-rules-test', userTokens.true.tokens.idToken);
    assertJobPayload(res);
  });

  await check('jobs/job-rules-test read by non-admin -> 403 Forbidden', async () => {
    const res = await firestoreRequest('jobs/job-rules-test', userTokens.false.tokens.idToken);
    assert.equal(res.status, 403);
  });

  // E. Driver regression checks (Phase 4 & 5 protection)
  await check('Driver can read own driver profile -> 200 OK', async () => {
    const res = await firestoreRequest('drivers/driver-rules-test-1', driverTokens.idToken);
    assertDriverPayload(res);
  });

  await check('Driver cannot read other driver profile -> 403 Forbidden', async () => {
    const res = await firestoreRequest('drivers/driver-rules-test-2', driverTokens.idToken);
    assert.equal(res.status, 403);
  });

  await check('Driver cannot read raw wallet entries without admin claim -> 403 Forbidden', async () => {
    const res = await firestoreRequest('wallet_entries/wallet-rules-test', driverTokens.idToken);
    assert.equal(res.status, 403);
  });

  // F. Token lifecycle and claim mutation transitions (D1, D2, D10)
  console.log('\n🔄 Verifying Claim Mutation & Token Refresh Transitions:');

  // 1. Demote admin user on server
  await adminAuth.setCustomUserClaims(userTokens.true.user.uid, { admin: false, fixture: 'rules-test' });

  // Older issued token remains valid until expiration or refresh
  await check('Older issued admin token remains accepted before token refresh -> 200 OK with payload', async () => {
    const res = await firestoreRequest('dispatch_config/main', userTokens.true.tokens.idToken);
    assertConfigPayload(res);
  });

  // Refresh token to get fresh demoted ID token
  const refreshedDemoted = await refreshToken(userTokens.true.tokens.refreshToken);
  await check('Fresh Auth-issued token after demotion is immediately rejected -> 403 Forbidden', async () => {
    const res = await firestoreRequest('dispatch_config/main', refreshedDemoted.id_token);
    assert.equal(res.status, 403);
  });

  // 2. Promote non-admin user on server
  await adminAuth.setCustomUserClaims(userTokens.false.user.uid, { admin: true, fixture: 'rules-test' });
  const refreshedPromoted = await refreshToken(userTokens.false.tokens.refreshToken);
  await check('Fresh Auth-issued token after promotion is immediately accepted -> 200 OK with payload', async () => {
    const res = await firestoreRequest('dispatch_config/main', refreshedPromoted.id_token);
    assertConfigPayload(res);
  });

  // Restore claims for cleanliness
  await adminAuth.setCustomUserClaims(userTokens.true.user.uid, { admin: true, fixture: 'rules-test' });
  await adminAuth.setCustomUserClaims(userTokens.false.user.uid, { admin: false, fixture: 'rules-test' });

  console.log(`\n\x1b[32m✔ All ${passed}/${total} security rules integration tests PASSED.\x1b[0m\n`);
}

run().catch((err) => {
  console.error(`\x1b[31m[TEST SUITE FAILURE]\x1b[0m ${err.message}`);
  process.exit(1);
});
