'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  createWalletTopupManager,
  createInitiateWalletTopupCallable,
  TopupError,
} = require('../../firebase/functions/src/wallet/topupService');
const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');
const { createFakeTopupProvider } = require('./fakeTopupProvider');

function setupTestEnvironment({ initialWalletBalance = 50000, nowMs = 1700000000000 } = {}) {
  const db = new FakeFirestore();
  const driverUid = 'driver_test_999';

  // Seed primary driver
  db.seed('drivers', driverUid, {
    uid: driverUid,
    name: 'Rohan Sharma',
    phone: '+919876543210',
    truckType: 'flatbed',
    vehicleNumber: 'MH 12 AB 1234',
    isOnDuty: true,
    verificationStatus: 'approved',
    walletBalance: initialWalletBalance,
    createdAt: FakeTimestamp.fromMillis(nowMs - 100000),
    updatedAt: FakeTimestamp.fromMillis(nowMs - 100000),
  });

  // Seed secondary driver for cross-driver isolation tests
  const secondDriverUid = 'driver_test_888';
  db.seed('drivers', secondDriverUid, {
    uid: secondDriverUid,
    name: 'Vikram Singh',
    phone: '+919876543211',
    truckType: 'flatbed',
    vehicleNumber: 'MH 12 CD 5678',
    isOnDuty: true,
    verificationStatus: 'approved',
    walletBalance: 10000,
    createdAt: FakeTimestamp.fromMillis(nowMs - 100000),
    updatedAt: FakeTimestamp.fromMillis(nowMs - 100000),
  });

  const manager = createWalletTopupManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(nowMs),
    razorpayClient: createFakeTopupProvider(),
  });

  const initiateCallable = createInitiateWalletTopupCallable({ topupManager: manager });

  return {
    db,
    driverUid,
    secondDriverUid,
    manager,
    initiateCallable,
    nowMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frozen Scenario Tests A through I
// ─────────────────────────────────────────────────────────────────────────────

test('Scenario E: unauthenticated initiation -> reject', async () => {
  const { initiateCallable } = setupTestEnvironment();

  await assert.rejects(
    async () => {
      await initiateCallable.run({
        auth: null, // Unauthenticated
        data: {
          amountPaise: 50000,
          requestId: 'req_unauth_001',
        },
      });
    },
    err => {
      assert.equal(err.code, 'unauthenticated');
      return true;
    }
  );
});

test('Scenario F: same requestId / same initiation payload -> same order/attempt returned', async () => {
  const { driverUid, initiateCallable } = setupTestEnvironment();

  const firstCall = await initiateCallable.run({
    auth: { uid: driverUid },
    data: {
      amountPaise: 50000,
      requestId: 'req_replay_001',
    },
  });

  const replayCall = await initiateCallable.run({
    auth: { uid: driverUid },
    data: {
      amountPaise: 50000,
      requestId: 'req_replay_001',
    },
  });

  assert.equal(replayCall.idempotent, true);
  assert.equal(replayCall.topupId, firstCall.topupId);
  assert.equal(replayCall.orderId, firstCall.orderId);
  assert.equal(replayCall.amountPaise, firstCall.amountPaise);
});

test('Scenario G: same requestId / conflicting amount -> reject', async () => {
  const { driverUid, initiateCallable } = setupTestEnvironment();

  await initiateCallable.run({
    auth: { uid: driverUid },
    data: {
      amountPaise: 50000,
      requestId: 'req_conflict_001',
    },
  });

  await assert.rejects(
    async () => {
      await initiateCallable.run({
        auth: { uid: driverUid },
        data: {
          amountPaise: 100000, // conflicting amount
          requestId: 'req_conflict_001',
        },
      });
    },
    err => {
      assert.equal(err.code, 'invalid-argument');
      return true;
    }
  );
});

test('Scenario D: amount mismatch -> reject', async () => {
  const { driverUid, manager } = setupTestEnvironment();

  const init = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_mismatch_amount',
    driverUid,
  });

  await assert.rejects(
    async () => {
      await manager.reconcileTopupPayment({
        topupId: init.topupId,
        orderId: init.orderId,
        paymentId: 'pay_test_mismatch',
        amountPaise: 99999, // Mismatched amount
        paymentStatus: 'captured',
      });
    },
    err => {
      assert.equal(err.code, 'AMOUNT_MISMATCH');
      return true;
    }
  );
});

test('Scenario A: two concurrent deliveries of same successful provider event -> exactly 1 increment, exactly 1 wallet_entries record', async () => {
  const { db, driverUid, manager } = setupTestEnvironment({ initialWalletBalance: 20000 });

  const init = await manager.initiateWalletTopup({
    amountPaise: 30000,
    requestId: 'req_concurrent_001',
    driverUid,
  });

  const [res1, res2] = await Promise.all([
    manager.reconcileTopupPayment({
      topupId: init.topupId,
      orderId: init.orderId,
      paymentId: 'pay_concurrent_001',
      amountPaise: 30000,
      paymentStatus: 'captured',
    }),
    manager.reconcileTopupPayment({
      topupId: init.topupId,
      orderId: init.orderId,
      paymentId: 'pay_concurrent_001',
      amountPaise: 30000,
      paymentStatus: 'captured',
    }),
  ]);

  assert.equal(res1.credited, true);
  assert.equal(res2.credited, true);

  // Exactly one increment: 20000 + 30000 = 50000 (NOT 80000)
  const driver = db.read('drivers', driverUid);
  assert.equal(driver.walletBalance, 50000);

  // Exactly one wallet_entries record under wallet_topup:{driverId}:{orderId}
  const operationId = 'wallet_topup:' + driverUid + ':' + init.orderId;
  const ledger = db.read('wallet_entries', operationId);
  assert.ok(ledger);
  assert.equal(ledger.operationId, operationId);
  assert.equal(ledger.deltaPaise, 30000);
  assert.equal(ledger.balanceBeforePaise, 20000);
  assert.equal(ledger.balanceAfterPaise, 50000);
});

test('Scenario B: same paymentId presented against different driver -> reject', async () => {
  const { driverUid, secondDriverUid, manager } = setupTestEnvironment();

  // Driver 1 creates attempt
  const init1 = await manager.initiateWalletTopup({
    amountPaise: 25000,
    requestId: 'req_driver1',
    driverUid,
  });

  // Driver 1 completes payment
  const res1 = await manager.reconcileTopupPayment({
    topupId: init1.topupId,
    orderId: init1.orderId,
    paymentId: 'pay_shared_001',
    amountPaise: 25000,
    driverId: driverUid,
    paymentStatus: 'captured',
  });
  assert.equal(res1.credited, true);

  // Driver 2 attempts to use the SAME paymentId
  const init2 = await manager.initiateWalletTopup({
    amountPaise: 25000,
    requestId: 'req_driver2',
    driverUid: secondDriverUid,
  });

  await assert.rejects(
    async () => {
      await manager.reconcileTopupPayment({
        topupId: init2.topupId,
        orderId: init2.orderId,
        paymentId: 'pay_shared_001', // Reused paymentId for driver 2!
        amountPaise: 25000,
        driverId: secondDriverUid,
        paymentStatus: 'captured',
      });
    },
    err => {
      assert.equal(err.code, 'PAYMENT_BINDING_CONFLICT');
      return true;
    }
  );
});

test('Scenario C: same paymentId presented against different order -> reject', async () => {
  const { driverUid, manager } = setupTestEnvironment();

  // Order 1
  const init1 = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_order1',
    driverUid,
  });

  await manager.reconcileTopupPayment({
    topupId: init1.topupId,
    orderId: init1.orderId,
    paymentId: 'pay_same_order_001',
    amountPaise: 20000,
    paymentStatus: 'captured',
  });

  // Order 2 by same driver
  const init2 = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_order2',
    driverUid,
  });

  await assert.rejects(
    async () => {
      await manager.reconcileTopupPayment({
        topupId: init2.topupId,
        orderId: init2.orderId,
        paymentId: 'pay_same_order_001', // Reused paymentId on new order!
        amountPaise: 20000,
        paymentStatus: 'captured',
      });
    },
    err => {
      assert.equal(err.code, 'PAYMENT_BINDING_CONFLICT');
      return true;
    }
  );
});

test('Scenario H: failed/cancelled provider state -> zero credit, zero wallet credit ledger entries', async () => {
  const { db, driverUid, manager } = setupTestEnvironment({ initialWalletBalance: 15000 });

  const init = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_fail_provider',
    driverUid,
  });

  const reconcile = await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_failed_provider_001',
    amountPaise: 20000,
    paymentStatus: 'failed',
  });

  assert.equal(reconcile.credited, false);
  assert.equal(reconcile.reason, 'failed');

  // Driver balance unchanged
  const driver = db.read('drivers', driverUid);
  assert.equal(driver.walletBalance, 15000);

  // ZERO wallet_entries records created
  const operationId = 'wallet_topup:' + driverUid + ':' + init.orderId;
  assert.equal(db.read('wallet_entries', operationId), undefined);

  // Attempt marked failed
  const attempt = db.read('wallet_topup_attempts', init.topupId);
  assert.equal(attempt.status, 'failed');
});

test('Scenario I: successful reconciliation replay -> idempotent no-op', async () => {
  const { db, driverUid, manager } = setupTestEnvironment({ initialWalletBalance: 10000 });

  const init = await manager.initiateWalletTopup({
    amountPaise: 25000,
    requestId: 'req_replay_reconcile',
    driverUid,
  });

  const first = await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_replay_001',
    amountPaise: 25000,
    paymentStatus: 'captured',
  });
  assert.equal(first.credited, true);
  assert.equal(first.balanceAfterPaise, 35000);

  // Replay reconciliation
  const replay = await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_replay_001',
    amountPaise: 25000,
    paymentStatus: 'captured',
  });

  assert.equal(replay.credited, true);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.balanceAfterPaise, 35000);

  // Balance remains 35000 (no duplicate credit)
  assert.equal(db.read('drivers', driverUid).walletBalance, 35000);
});

test('Wallet Top-Up: Bound operational state & immutable ledger verification', async () => {
  const { db, driverUid, manager } = setupTestEnvironment({ initialWalletBalance: 5000 });

  const init = await manager.initiateWalletTopup({
    amountPaise: 10000,
    requestId: 'req_ledger_schema_001',
    driverUid,
  });

  await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_ledger_schema_001',
    amountPaise: 10000,
    paymentStatus: 'captured',
  });

  const operationId = 'wallet_topup:' + driverUid + ':' + init.orderId;
  const ledger = db.read('wallet_entries', operationId);

  assert.ok(ledger);
  assert.equal(ledger.operationId, operationId);
  assert.equal(ledger.type, 'wallet_topup');
  assert.equal(ledger.driverId, driverUid);
  assert.equal(ledger.topupId, init.topupId);
  assert.equal(ledger.orderId, init.orderId);
  assert.equal(ledger.paymentId, 'pay_ledger_schema_001');
  assert.equal(ledger.amountPaise, 10000);
  assert.equal(ledger.deltaPaise, 10000);
  assert.equal(ledger.balanceBeforePaise, 5000);
  assert.equal(ledger.balanceAfterPaise, 15000);
  assert.equal(ledger.status, 'credited');
  assert.equal(ledger.sourceRequestId, 'req_ledger_schema_001');
});

// ─────────────────────────────────────────────────────────────────────────────
// Maintained Regression Tests for F01, F02, F03
// ─────────────────────────────────────────────────────────────────────────────

test('F02: Terminal credited attempt rejects conflicting replays for all identity selectors', async () => {
  const { db, driverUid, secondDriverUid, manager } = setupTestEnvironment({ initialWalletBalance: 20000 });

  const init = await manager.initiateWalletTopup({
    amountPaise: 10000,
    requestId: 'req_f02_exact_001',
    driverUid,
  });

  const exactPayload = {
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_f02_exact_001',
    amountPaise: 10000,
    driverId: driverUid,
    paymentStatus: 'captured',
  };

  const initialCredit = await manager.reconcileTopupPayment(exactPayload);
  assert.equal(initialCredit.credited, true);
  assert.equal(initialCredit.balanceAfterPaise, 30000);

  // Exact replay succeeds idempotently
  const exactReplay = await manager.reconcileTopupPayment(exactPayload);
  assert.equal(exactReplay.credited, true);
  assert.equal(exactReplay.idempotent, true);

  // 1. Conflicting driverId
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, driverId: secondDriverUid }),
    err => err instanceof TopupError && err.code === 'DRIVER_MISMATCH'
  );

  // 2. Conflicting orderId
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, orderId: 'order_wrong_f02' }),
    err => err instanceof TopupError && err.code === 'ORDER_MISMATCH'
  );

  // 3. Conflicting amountPaise
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, amountPaise: 99999 }),
    err => err instanceof TopupError && err.code === 'AMOUNT_MISMATCH'
  );

  // 4. Conflicting paymentId
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, paymentId: 'pay_different_f02' }),
    err => err instanceof TopupError && err.code === 'PAYMENT_ID_MISMATCH'
  );

  // Balance remains 30000, no mutations occurred
  assert.equal(db.read('drivers', driverUid).walletBalance, 30000);
});

for (const corruptBalance of ['20000', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`F03: Malformed existing wallet fails closed: ${JSON.stringify(corruptBalance)}`, async () => {
    const { db, driverUid, manager } = setupTestEnvironment();
    // Overwrite driver with corrupt balance
    db.seed('drivers', driverUid, {
      ...db.read('drivers', driverUid),
      walletBalance: corruptBalance,
    });

    const init = await manager.initiateWalletTopup({
      amountPaise: 10000,
      requestId: `req_f03_${String(corruptBalance).replace(/[^a-zA-Z0-9]/g, '_')}`,
      driverUid,
    });

    await assert.rejects(
      manager.reconcileTopupPayment({
        topupId: init.topupId,
        orderId: init.orderId,
        paymentId: `pay_f03_${String(corruptBalance).replace(/[^a-zA-Z0-9]/g, '_')}`,
        amountPaise: 10000,
        driverId: driverUid,
        paymentStatus: 'captured',
      }),
      err => err instanceof TopupError && err.code === 'MALFORMED_WALLET_STATE'
    );

    // Assert driver balance is completely untouched and zero wallet_entries written
    assert.equal(db.read('drivers', driverUid).walletBalance, corruptBalance);
    const operationId = 'wallet_topup:' + driverUid + ':' + init.orderId;
    assert.equal(db.read('wallet_entries', operationId), undefined);
  });
}

test('F01: Real provider order creation and verified webhook reconciliation', async () => {
  const db = new FakeFirestore();
  const driverUid = 'driver_rzp_provider_001';
  db.seed('drivers', driverUid, {
    uid: driverUid,
    verificationStatus: 'approved',
    walletBalance: 15000,
  });

  const capturedOrderCalls = [];
  const mockRazorpay = {
    createOrder: async params => {
      capturedOrderCalls.push(params);
      return { id: 'order_rzp_real_provider_123', keyId: 'rzp_injected_provider', status: 'created', ...params };
    },
  };

  const manager = createWalletTopupManager({
    db,
    TimestampClass: FakeTimestamp,
    now: () => new Date(),
    razorpayClient: mockRazorpay,
  });

  const init = await manager.initiateWalletTopup({
    amountPaise: 25000,
    requestId: 'req_rzp_provider_001',
    driverUid,
  });

  assert.equal(capturedOrderCalls.length, 1);
  assert.equal(capturedOrderCalls[0].amount, 25000);
  assert.equal(capturedOrderCalls[0].receipt, init.topupId);
  assert.equal(capturedOrderCalls[0].notes.driverId, driverUid);
  assert.equal(init.orderId, 'order_rzp_real_provider_123');

  // Verify attempt persists real provider orderId
  const attempt = db.read('wallet_topup_attempts', init.topupId);
  assert.equal(attempt.orderId, 'order_rzp_real_provider_123');
  assert.equal(attempt.status, 'pending');

  // Authoritative reconciliation credits wallet
  const credit = await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_rzp_verified_123',
    amountPaise: 25000,
    driverId: driverUid,
    paymentStatus: 'captured',
  });

  assert.equal(credit.credited, true);
  assert.equal(credit.balanceAfterPaise, 40000); // 15000 + 25000
  assert.equal(db.read('drivers', driverUid).walletBalance, 40000);
});
