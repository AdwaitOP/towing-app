'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp: T } = require('firebase-admin/firestore');
const { createWalletTopupManager } = require('../../firebase/functions/src/wallet/topupService');
const { createFakeTopupProvider } = require('./fakeTopupProvider');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) {
  throw new Error('FIRESTORE_EMULATOR_HOST is required for emulator test');
}

const project = 'towing-stage5-topup-emulator-test';
const app = getApps().find(a => a.name === 'stage5-topup-emulator') || initializeApp({ projectId: project }, 'stage5-topup-emulator');
const db = getFirestore(app);

test.beforeEach(async () => {
  const response = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  assert.equal(response.ok, true);
});

test.after(async () => {
  await db.terminate();
  await app.delete();
});

test('Real Firestore Emulator: 1. Atomic wallet topup transaction credits wallet and creates authoritative wallet_entries ledger', async () => {
  const driverUid = 'driver_emulator_001';
  const driverRef = db.collection('drivers').doc(driverUid);

  await driverRef.set({
    uid: driverUid,
    name: 'Suresh Raina',
    phone: '+919876543210',
    verificationStatus: 'approved',
    isOnDuty: true,
    walletBalance: 20000, // ₹200.00
    createdAt: T.now(),
    updatedAt: T.now(),
  });

  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  // Step 1: Initiate
  const init = await manager.initiateWalletTopup({
    amountPaise: 50000, // ₹500.00
    requestId: 'req_emu_001',
    driverUid,
  });

  assert.equal(init.amountPaise, 50000);
  assert.equal(init.status, 'pending');

  // Verify attempt written in real emulator
  const attemptSnap = await db.collection('wallet_topup_attempts').doc(init.topupId).get();
  assert.equal(attemptSnap.exists, true);
  assert.equal(attemptSnap.data().status, 'pending');

  // Step 2: Reconcile / Capture
  const result = await manager.reconcileTopupPayment({
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_emu_test_123',
    amountPaise: 50000,
    driverId: driverUid,
    paymentStatus: 'captured',
  });

  assert.equal(result.credited, true);
  assert.equal(result.balanceAfterPaise, 70000); // 20000 + 50000

  // Verify driver balance in real emulator
  const updatedDriverSnap = await driverRef.get();
  assert.equal(updatedDriverSnap.data().walletBalance, 70000);

  // Verify authoritative wallet_entries document
  const expectedOperationId = `wallet_topup:${driverUid}:${init.orderId}`;
  const ledgerSnap = await db.collection('wallet_entries').doc(expectedOperationId).get();
  assert.equal(ledgerSnap.exists, true);
  const ledger = ledgerSnap.data();
  assert.equal(ledger.operationId, expectedOperationId);
  assert.equal(ledger.type, 'wallet_topup');
  assert.equal(ledger.driverId, driverUid);
  assert.equal(ledger.amountPaise, 50000);
  assert.equal(ledger.deltaPaise, 50000);
  assert.equal(ledger.balanceBeforePaise, 20000);
  assert.equal(ledger.balanceAfterPaise, 70000);
  assert.equal(ledger.paymentId, 'pay_emu_test_123');
});

test('Real Firestore Emulator: 2. Concurrent reconciliation deliveries credit exactly once in real transactions', async () => {
  const driverUid = 'driver_emulator_concurrent';
  const driverRef = db.collection('drivers').doc(driverUid);

  await driverRef.set({
    uid: driverUid,
    name: 'Zaheer Khan',
    phone: '+919876543212',
    verificationStatus: 'approved',
    isOnDuty: true,
    walletBalance: 15000,
    createdAt: T.now(),
    updatedAt: T.now(),
  });

  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  const init = await manager.initiateWalletTopup({
    amountPaise: 30000,
    requestId: 'req_emu_concurrent_001',
    driverUid,
  });

  // Execute two concurrent reconciliation calls against the live Firestore emulator
  const [res1, res2] = await Promise.all([
    manager.reconcileTopupPayment({
      topupId: init.topupId,
      orderId: init.orderId,
      paymentId: 'pay_emu_concurrent_123',
      amountPaise: 30000,
      driverId: driverUid,
      paymentStatus: 'captured',
    }),
    manager.reconcileTopupPayment({
      topupId: init.topupId,
      orderId: init.orderId,
      paymentId: 'pay_emu_concurrent_123',
      amountPaise: 30000,
      driverId: driverUid,
      paymentStatus: 'captured',
    }),
  ]);

  assert.equal(res1.credited, true);
  assert.equal(res2.credited, true);

  // Exactly one wallet increment in live Firestore
  const finalDriverSnap = await driverRef.get();
  assert.equal(finalDriverSnap.data().walletBalance, 45000); // 15000 + 30000

  // Exactly one ledger entry exists
  const expectedOperationId = `wallet_topup:${driverUid}:${init.orderId}`;
  const ledgerSnap = await db.collection('wallet_entries').doc(expectedOperationId).get();
  assert.equal(ledgerSnap.exists, true);
});

test('Real Firestore Emulator: 3. Cross-driver payment reuse is rejected in real transaction', async () => {
  const driver1 = 'driver_emu_d1';
  const driver2 = 'driver_emu_d2';

  await db.collection('drivers').doc(driver1).set({
    uid: driver1,
    name: 'Driver One',
    phone: '+919876543213',
    verificationStatus: 'approved',
    walletBalance: 10000,
  });
  await db.collection('drivers').doc(driver2).set({
    uid: driver2,
    name: 'Driver Two',
    phone: '+919876543214',
    verificationStatus: 'approved',
    walletBalance: 10000,
  });

  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  const init1 = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_d1',
    driverUid: driver1,
  });

  await manager.reconcileTopupPayment({
    topupId: init1.topupId,
    orderId: init1.orderId,
    paymentId: 'pay_shared_emu',
    amountPaise: 20000,
    driverId: driver1,
    paymentStatus: 'captured',
  });

  // Attempt to reuse same paymentId for driver2
  const init2 = await manager.initiateWalletTopup({
    amountPaise: 20000,
    requestId: 'req_d2',
    driverUid: driver2,
  });

  await assert.rejects(
    async () => {
      await manager.reconcileTopupPayment({
        topupId: init2.topupId,
        orderId: init2.orderId,
        paymentId: 'pay_shared_emu',
        amountPaise: 20000,
        driverId: driver2,
        paymentStatus: 'captured',
      });
    },
    err => {
      assert.equal(err.code, 'PAYMENT_BINDING_CONFLICT');
      return true;
    }
  );
});

test('Real Firestore Emulator: 4. F02: Conflicting terminal replays reject in live transaction', async () => {
  const driverUid = 'driver_emu_f02';
  const driverRef = db.collection('drivers').doc(driverUid);

  await driverRef.set({
    uid: driverUid,
    name: 'F02 Tester',
    phone: '+919876543219',
    verificationStatus: 'approved',
    isOnDuty: true,
    walletBalance: 20000,
    createdAt: T.now(),
    updatedAt: T.now(),
  });

  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  const init = await manager.initiateWalletTopup({
    amountPaise: 10000,
    requestId: 'req_emu_f02',
    driverUid,
  });

  const exactPayload = {
    topupId: init.topupId,
    orderId: init.orderId,
    paymentId: 'pay_emu_f02_exact',
    amountPaise: 10000,
    driverId: driverUid,
    paymentStatus: 'captured',
  };

  const initial = await manager.reconcileTopupPayment(exactPayload);
  assert.equal(initial.credited, true);
  assert.equal(initial.balanceAfterPaise, 30000);

  // Exact replay is idempotent
  const replay = await manager.reconcileTopupPayment(exactPayload);
  assert.equal(replay.idempotent, true);

  // Conflicting driverId rejects
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, driverId: 'wrong_driver' }),
    err => err.code === 'DRIVER_MISMATCH'
  );

  // Conflicting orderId rejects
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, orderId: 'wrong_order' }),
    err => err.code === 'ORDER_MISMATCH'
  );

  // Conflicting amountPaise rejects
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, amountPaise: 99999 }),
    err => err.code === 'AMOUNT_MISMATCH'
  );

  // Conflicting paymentId rejects
  await assert.rejects(
    manager.reconcileTopupPayment({ ...exactPayload, paymentId: 'wrong_payment' }),
    err => err.code === 'PAYMENT_ID_MISMATCH'
  );

  // Verify driver balance was not mutated by rejected replays
  const snap = await driverRef.get();
  assert.equal(snap.data().walletBalance, 30000);
});

test('Real Firestore Emulator: 5. F03: Malformed existing wallet state fails closed in live transaction', async () => {
  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  for (const corruptBalance of ['20000', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const driverUid = `driver_emu_f03_${String(corruptBalance).replace(/[^a-zA-Z0-9]/g, '_')}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      verificationStatus: 'approved',
      walletBalance: corruptBalance,
    });

    const init = await manager.initiateWalletTopup({
      amountPaise: 10000,
      requestId: `req_emu_f03_${driverUid}`,
      driverUid,
    });

    await assert.rejects(
      manager.reconcileTopupPayment({
        topupId: init.topupId,
        orderId: init.orderId,
        paymentId: `pay_emu_f03_${driverUid}`,
        amountPaise: 10000,
        driverId: driverUid,
        paymentStatus: 'captured',
      }),
      err => err.code === 'MALFORMED_WALLET_STATE'
    );

    // Verify driver balance is untouched
    const snap = await driverRef.get();
    assert.equal(snap.data().walletBalance, corruptBalance);
  }
});

test('Real Firestore Emulator: 6. Failed, cancelled or expired provider status credits zero and creates no ledger entries', async () => {
  const manager = createWalletTopupManager({
    db,
    razorpayClient: createFakeTopupProvider(),
    TimestampClass: T,
    now: () => new Date(),
  });

  for (const status of ['failed', 'cancelled', 'expired']) {
    const driverUid = `driver_emu_failed_${status}`;
    const driverRef = db.collection('drivers').doc(driverUid);

    await driverRef.set({
      uid: driverUid,
      verificationStatus: 'approved',
      walletBalance: 25000,
    });

    const init = await manager.initiateWalletTopup({
      amountPaise: 10000,
      requestId: `req_emu_failed_${status}`,
      driverUid,
    });

    const result = await manager.reconcileTopupPayment({
      topupId: init.topupId,
      orderId: init.orderId,
      paymentId: `pay_emu_failed_${status}`,
      amountPaise: 10000,
      driverId: driverUid,
      paymentStatus: status,
    });

    assert.equal(result.credited, false);

    // Verify driver balance is unchanged
    const snap = await driverRef.get();
    assert.equal(snap.data().walletBalance, 25000);

    // Verify no ledger entry created
    const expectedOperationId = `wallet_topup:${driverUid}:${init.orderId}`;
    const ledgerSnap = await db.collection('wallet_entries').doc(expectedOperationId).get();
    assert.equal(ledgerSnap.exists, false);
  }
});
