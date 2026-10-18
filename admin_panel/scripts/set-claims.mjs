#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Controlled Claim Mutation Tool
 *
 * Requirements (Section 5):
 * - Safe, repeatable, emulator-only tool
 * - Strict boolean claim semantics: --admin true | false
 * - Preserves unrelated existing custom claims
 * - Never touches live services
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

// Strict Fail-Closed Environment Checks
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

const email = getArg('--email');
const adminVal = getArg('--admin');

if (!email || !adminVal) {
  console.error('\x1b[31mUsage: node scripts/set-claims.mjs --email <user-email> --admin <true|false>\x1b[0m');
  process.exit(1);
}

if (adminVal !== 'true' && adminVal !== 'false') {
  console.error(`\x1b[31m[ERROR] Invalid claim value: "${adminVal}".\x1b[0m`);
  console.error('Strict Boolean semantics required: must be exactly "true" or "false".');
  process.exit(1);
}

const adminBool = adminVal === 'true';

const app = getApps().length === 0 ? initializeApp({ projectId: EXPECTED_PROJECT_ID }) : getApps()[0];
const adminAuth = getAuth(app);

async function run() {
  const user = await adminAuth.getUserByEmail(email);
  const existingClaims = user.customClaims || {};

  const updatedClaims = {
    ...existingClaims,
    admin: adminBool,
  };

  await adminAuth.setCustomUserClaims(user.uid, updatedClaims);

  console.log(`\n\x1b[32m[SUCCESS] Updated custom claims for user:\x1b[0m ${email}`);
  console.log('UID:', user.uid);
  console.log('Previous Claims:', JSON.stringify(existingClaims));
  console.log('New Claims:     ', JSON.stringify(updatedClaims));
  console.log('\nNote: Active browser sessions must execute "Refresh Authorization" (getIdTokenResult(true))');
  console.log('to immediately refresh claims on their issued ID token.\n');
}

run().catch((err) => {
  console.error('\x1b[31m[ERROR] Failed to set claims:\x1b[0m', err.message);
  process.exit(1);
});
