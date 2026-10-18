#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Emulator Bootstrap Fixture Tool
 *
 * Requirements (Section 5):
 * - Safe, repeatable, emulator-only bootstrap
 * - Never support service-account or live mode
 * - Fail when emulator endpoints are missing or unsafe
 * - Preserve unrelated existing custom claims
 * - Strict boolean claim semantics
 * - Create synthetic dispatch_config/main document
 * - Fictional development credentials only
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

// Strict Fail-Closed Environment Checks
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const firestoreHost = validateEmulatorHost('FIRESTORE_EMULATOR_HOST', process.env.FIRESTORE_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

const app = getApps().length === 0 ? initializeApp({ projectId: EXPECTED_PROJECT_ID }) : getApps()[0];
const adminAuth = getAuth(app);
const adminDb = getFirestore(app);

const SYNTHETIC_USERS = [
  {
    email: 'admin@towmitra.test',
    password: 'AdminPassword123!',
    displayName: 'Operations Co-Owner',
    claims: { admin: true },
  },
  {
    email: 'admin-b@towmitra.test',
    password: 'AdminPassword123!',
    displayName: 'Operations Co-Owner B',
    claims: { admin: true },
  },
  {
    email: 'operator@towmitra.test',
    password: 'OperatorPassword123!',
    displayName: 'Dispatch Operator (Non-Admin)',
    claims: { admin: false },
  },
];

async function upsertUser({ email, password, displayName, claims }) {
  let userRecord;
  try {
    userRecord = await adminAuth.getUserByEmail(email);
    await adminAuth.updateUser(userRecord.uid, {
      password,
      displayName,
    });
    console.log(`  Updated existing user: ${email} (UID: ${userRecord.uid})`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      userRecord = await adminAuth.createUser({
        email,
        password,
        displayName,
        emailVerified: true,
      });
      console.log(`  Created synthetic user: ${email} (UID: ${userRecord.uid})`);
    } else {
      throw err;
    }
  }

  // Preserve any existing claims while setting admin status strictly
  const existingClaims = userRecord.customClaims || {};
  const mergedClaims = {
    ...existingClaims,
    ...claims,
  };

  await adminAuth.setCustomUserClaims(userRecord.uid, mergedClaims);
  console.log(`  Applied claims for ${email}:`, JSON.stringify(mergedClaims));
  return userRecord;
}

async function seedDispatchConfig() {
  const docRef = adminDb.collection('dispatch_config').doc('main');
  const syntheticConfig = {
    version: 1,
    rankingPrimary: 'ola_eta_seconds',
    rankingSecondary: 'ola_distance_meters',
    rankingTieBreak: 'driver_uid',
    olaFailureMode: 'bounded_retry_then_haversine_degraded',
    olaMonthlyPairCap: null,
    locationFreshnessSeconds: 120,
    radiusKmSequence: [10, 20, 35],
    maxUniqueCandidatesPerGeneration: 30,
    maxMatrixShortlistPerRound: 10,
    syntheticFixture: true,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await docRef.set(syntheticConfig, { merge: true });
  console.log('  Seeded dispatch_config/main in Firestore emulator.');
}

async function run() {
  console.log('\n======================================================');
  console.log(' TowMitra Admin Panel — Emulator Bootstrap Fixture Tool');
  console.log('======================================================');
  console.log(`Target Project: ${EXPECTED_PROJECT_ID}`);
  console.log(`Auth Emulator:     ${authHost}`);
  console.log(`Firestore Emulator: ${firestoreHost}\n`);

  console.log('[1/2] Provisioning Synthetic Accounts...');
  for (const user of SYNTHETIC_USERS) {
    await upsertUser(user);
  }

  console.log('\n[2/2] Seeding Server Authorization Proof Document...');
  await seedDispatchConfig();

  console.log('\n\x1b[32m[SUCCESS] Bootstrap complete. Ready for local admin testing.\x1b[0m');
  console.log('------------------------------------------------------');
  console.log('Admin Account:     admin@towmitra.test    (admin: true)');
  console.log('Non-Admin Account: operator@towmitra.test (admin: false)');
  console.log('Password (both):   AdminPassword123! / OperatorPassword123!');
  console.log('------------------------------------------------------\n');
}

run().catch((err) => {
  console.error('\x1b[31m[ERROR] Bootstrap failed:\x1b[0m', err);
  process.exit(1);
});
