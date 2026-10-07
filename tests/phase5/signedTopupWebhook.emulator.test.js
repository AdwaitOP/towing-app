'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { registerSignedTopupWebhookCases } = require('./signedTopupWebhookCases');
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) throw new Error('Loopback FIRESTORE_EMULATOR_HOST is required');
const projectId = 'demo-phase5-final-signed-financial';
const app = initializeApp({ projectId }, 'final-signed-financial');
const db = getFirestore(app);
test.beforeEach(async () => {
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(response.ok, true);
});
test.after(async () => { await db.terminate(); await app.delete(); });
registerSignedTopupWebhookCases(async () => ({ db, TimestampClass: Timestamp }), 'REAL Firestore');
