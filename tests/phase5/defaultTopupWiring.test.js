'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');
const firestore = require('firebase-admin/firestore');
const db = new FakeFirestore();
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'firebase-admin/firestore') return { ...firestore, getFirestore: () => db, Timestamp: FakeTimestamp };
  return originalLoad.call(this, name, ...args);
};
let exported, topup;
try {
  // Load the actual deployment entry point; only disposable database data is substituted.
  exported = require('../../firebase/functions/src/index');
  topup = require('../../firebase/functions/src/wallet/topupService');
} finally {
  Module._load = originalLoad;
}
const provider = require('../../firebase/functions/src/services/razorpayClient');
const { createFakeTopupProvider } = require('./fakeTopupProvider');
const originalFetch = globalThis.fetch;
const oldKeyId = process.env.RAZORPAY_KEY_ID;
const oldSecret = process.env.RAZORPAY_KEY_SECRET;
let calls, providerCalls, failure;
const createOrder = provider.createOrder;
provider.createOrder = async (...args) => { providerCalls++; return createOrder(...args); };
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.razorpay.com/v1/orders');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  calls.push(body);
  if (failure) throw new Error('controlled provider outage');
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `order_provider_${body.receipt}`, ...body }) };
};
test.beforeEach(() => {
  db.data = {};
  db.seed('drivers', 'authenticated_driver', { walletBalance: 20000 });
  calls = []; providerCalls = 0; failure = false;
  process.env.RAZORPAY_KEY_ID = 'rzp_controlled_provider_key';
  process.env.RAZORPAY_KEY_SECRET = 'disposable-test-secret';
});
test.after(() => {
  provider.createOrder = createOrder;
  globalThis.fetch = originalFetch;
  if (oldKeyId === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = oldKeyId;
  if (oldSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET; else process.env.RAZORPAY_KEY_SECRET = oldSecret;
});
const request = (requestId = 'default_request', amountPaise = 10000) => ({
  auth: { uid: 'authenticated_driver' },
  data: { requestId, amountPaise, driverUid: 'forged_driver' },
});

test('F01 actual exported default callable invokes provider and returns its order/key identity', async () => {
  assert.equal(exported.initiateWalletTopup, topup.initiateWalletTopup);
  const result = await exported.initiateWalletTopup.run(request());
  assert.equal(providerCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].notes.driverId, 'authenticated_driver');
  assert.equal(calls[0].amount, 10000);
  assert.equal(result.orderId, 'order_provider_topup_default_request');
  assert.equal(result.keyId, 'rzp_controlled_provider_key');
  assert.equal(result.status, 'pending');
  assert.equal(db.read('wallet_topup_attempts', result.topupId).orderId, result.orderId);
  assert.equal(db.read('wallet_topup_attempts', result.topupId).keyId, result.keyId);
  assert.equal(db.read('drivers', 'authenticated_driver').walletBalance, 20000);
});

test('F01 exported default same-request retry preserves identity without a second provider call', async () => {
  const initial = await exported.initiateWalletTopup.run(request());
  failure = true; // A bound retry still works even if the provider is now unavailable.
  const retry = await exported.initiateWalletTopup.run(request());
  assert.equal(retry.idempotent, true);
  assert.equal(retry.orderId, initial.orderId);
  assert.equal(retry.keyId, initial.keyId);
  assert.equal(providerCalls, 1);
});

test('F01 exported default provider failure rejects without any initiated attempt or receipt', async () => {
  failure = true;
  await assert.rejects(exported.initiateWalletTopup.run(request()), error => {
    assert.equal(error.code, 'failed-precondition');
    assert.equal(error.details.code, 'PROVIDER_INITIATION_FAILED');
    return true;
  });
  assert.equal(providerCalls, 1);
  assert.equal(db.read('wallet_topup_attempts', 'topup_default_request'), undefined);
  assert.equal(db.read('processed_requests', 'default_request'), undefined);
  assert.doesNotMatch(JSON.stringify(db.data), /order_test_|rzp_test_mode/);
  assert.equal(db.read('drivers', 'authenticated_driver').walletBalance, 20000);
  failure = false;
  assert.equal((await exported.initiateWalletTopup.run(request())).status, 'pending');
});

test('F01 explicitly missing provider fails closed without fabricated order writes', async () => {
  const manager = topup.createWalletTopupManager({ db, TimestampClass: FakeTimestamp, razorpayClient: null });
  await assert.rejects(manager.initiateWalletTopup({ driverUid: 'authenticated_driver', amountPaise: 10000, requestId: 'missing' }),
    error => error.code === 'PROVIDER_INITIATION_FAILED');
  assert.equal(db.read('wallet_topup_attempts', 'topup_missing'), undefined);
  assert.equal(db.read('processed_requests', 'missing'), undefined);
});

test('F01 explicitly injected fake provider supports controlled unit tests', async () => {
  const manager = topup.createWalletTopupManager({ db, TimestampClass: FakeTimestamp, razorpayClient: createFakeTopupProvider() });
  const result = await manager.initiateWalletTopup({ driverUid: 'authenticated_driver', amountPaise: 10000, requestId: 'injected' });
  assert.equal(result.orderId, 'order_injected_1');
  assert.equal(result.keyId, 'rzp_injected_fixture');
  assert.equal(providerCalls, 0);
});

test('F01 exported default conflicting payload/actor retries reject before provider creation', async () => {
  await exported.initiateWalletTopup.run(request());
  await assert.rejects(exported.initiateWalletTopup.run(request('default_request', 10001)), error => error.details.code === 'REQUEST_PAYLOAD_MISMATCH');
  db.seed('drivers', 'other_driver', { walletBalance: 20000 });
  await assert.rejects(exported.initiateWalletTopup.run({ ...request(), auth: { uid: 'other_driver' } }), error => error.details.code === 'REQUEST_BINDING_CONFLICT');
  assert.equal(providerCalls, 1);
});

test('F01 injected order-entity provider retains configured public-key compatibility', async () => {
  const manager = topup.createWalletTopupManager({ db, TimestampClass: FakeTimestamp,
    razorpayClient: { createOrder: async () => ({ id: 'order_explicit_entity' }) } });
  const result = await manager.initiateWalletTopup({ driverUid: 'authenticated_driver', amountPaise: 10000, requestId: 'entity_provider' });
  assert.equal(result.orderId, 'order_explicit_entity');
  assert.equal(result.keyId, process.env.RAZORPAY_KEY_ID);
});
