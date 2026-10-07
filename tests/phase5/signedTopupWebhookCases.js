'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWalletTopupManager } = require('../../firebase/functions/src/wallet/topupService');
const { createRazorpayWebhook } = require('../../firebase/functions/src/payments/razorpayWebhook');
const { createFakeTopupProvider } = require('./fakeTopupProvider');
const secret = 'disposable-signed-financial-regression-secret';

function registerSignedTopupWebhookCases(setupDb, label) {
  async function setup() {
    const { db, TimestampClass } = await setupDb();
    const driverId = 'signed_driver';
    await db.collection('drivers').doc(driverId).set({ walletBalance: 20000 });
    const manager = createWalletTopupManager({ db, TimestampClass, razorpayClient: createFakeTopupProvider() });
    const init = await manager.initiateWalletTopup({ driverUid: driverId, amountPaise: 10000, requestId: 'signed_request' });
    const body = { event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_signed_binding', order_id: init.orderId, amount: 10000, status: 'captured',
      notes: { driverId, topupId: init.topupId },
    } } } };
    const webhook = createRazorpayWebhook({ db, TimestampClass, env: { RAZORPAY_WEBHOOK_SECRET: secret } });
    async function invoke(input = body, validSignature = true) {
      const rawBody = Buffer.from(JSON.stringify(input));
      const signature = validSignature ? crypto.createHmac('sha256', secret).update(rawBody).digest('hex') : 'invalid';
      const req = { method: 'POST', body: input, rawBody, headers: { 'x-razorpay-signature': signature } };
      const res = { code: 200, status(code) { this.code = code; return this; }, send() { return this; }, sendStatus(code) { this.code = code; return this; } };
      await webhook.handleRazorpayWebhook(req, res);
      return res.code;
    }
    async function snapshot() {
      return {
        driver: (await db.collection('drivers').doc(driverId).get()).data(),
        ledger: (await db.collection('wallet_entries').get()).docs.map(doc => ({ id: doc.id, data: doc.data() })),
        receipt: (await db.collection('processed_requests').doc('razorpay:topup:pay_signed_binding').get()).data(),
      };
    }
    return { db, body, invoke, snapshot };
  }

  test(`${label} F02 signed capture credits once; exact terminal replay has zero mutations`, async () => {
    const s = await setup();
    assert.equal(await s.invoke(), 200);
    const before = await s.snapshot();
    assert.equal(before.driver.walletBalance, 30000);
    assert.equal(before.ledger.length, 1);
    assert.equal(before.ledger[0].data.deltaPaise, 10000);
    assert.equal(before.receipt.status, 'completed');
    assert.match(before.receipt.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(await s.invoke(), 200);
    assert.deepEqual(await s.snapshot(), before);
  });

  for (const field of ['driverId', 'topupId', 'orderId', 'amountPaise', 'paymentId']) {
    test(`${label} F02 signed terminal replay rejects wrong ${field}, preserving original wallet/ledger/receipt`, async () => {
      const s = await setup();
      assert.equal(await s.invoke(), 200);
      const before = await s.snapshot();
      const wrong = structuredClone(s.body);
      const payment = wrong.payload.payment.entity;
      if (field === 'driverId') payment.notes.driverId = 'wrong_driver';
      if (field === 'topupId') payment.notes.topupId = 'wrong_topup';
      if (field === 'orderId') payment.order_id = 'wrong_order';
      if (field === 'amountPaise') payment.amount = 10001;
      // A different payment ID reaches a different receipt, then the existing
      // manager's credited-attempt payment-ID fence; no impossible same-ID event.
      if (field === 'paymentId') payment.id = 'pay_different_signed';
      assert.equal(await s.invoke(wrong), field === 'paymentId' ? 500 : 409);
      assert.deepEqual(await s.snapshot(), before);
      assert.equal(await s.invoke(), 200);
      assert.deepEqual(await s.snapshot(), before);
    });
  }

  test(`${label} invalid HMAC is rejected before credit or receipt claim`, async () => {
    const s = await setup();
    assert.equal(await s.invoke(s.body, false), 401);
    const state = await s.snapshot();
    assert.equal(state.driver.walletBalance, 20000);
    assert.equal(state.ledger.length, 0);
    assert.equal(state.receipt, undefined);
  });
}

module.exports = { registerSignedTopupWebhookCases };
