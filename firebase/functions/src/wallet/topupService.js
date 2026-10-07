'use strict';

const crypto = require('node:crypto');
const defaultRazorpayClient = require('../services/razorpayClient');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const https = require('firebase-functions/v2/https');
const onCall = typeof https?.onCall === 'function'
  ? https.onCall
  : ((...args) => {
      const handler = args.length === 1 ? args[0] : args[1];
      const fn = (...callArgs) => handler(...callArgs);
      fn.run = handler;
      return fn;
    });
const HttpsError = https?.HttpsError || class HttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
};

class TopupError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function createWalletTopupManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  razorpayClient = defaultRazorpayClient,
} = {}) {
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function initiateWalletTopup({ amountPaise, requestId, driverUid } = {}) {
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > 10000000) {
      throw new TopupError('INVALID_AMOUNT', 'amountPaise must be a safe positive integer between 100 and 10000000');
    }
    if (typeof requestId !== 'string' || !requestId || requestId.trim() !== requestId || requestId.includes('/')) {
      throw new TopupError('INVALID_REQUEST_ID', 'requestId must be a non-empty canonical string');
    }
    if (typeof driverUid !== 'string' || !driverUid || driverUid.includes('/')) {
      throw new TopupError('UNAUTHENTICATED', 'Driver must be authenticated');
    }

    const topupId = 'topup_' + requestId;
    const attemptRef = db.collection('wallet_topup_attempts').doc(topupId);
    const receiptRef = db.collection('processed_requests').doc(requestId);
    const driverRef = db.collection('drivers').doc(driverUid);
    const expectedPayloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ amountPaise }), 'utf8')
      .digest('hex');

    async function readInitiation(tx) {
      const [driverSnap, receiptSnap, attemptSnap] = await Promise.all([
        tx.get(driverRef),
        tx.get(receiptRef),
        tx.get(attemptRef),
      ]);

      if (!driverSnap.exists) {
        throw new TopupError('DRIVER_NOT_FOUND', 'Driver document does not exist');
      }

      // Idempotency: same requestId retry
      if (receiptSnap.exists) {
        const receipt = receiptSnap.data();
        if (receipt.actorUid !== driverUid) {
          throw new TopupError('REQUEST_BINDING_CONFLICT', 'requestId was used by another driver');
        }
        if (receipt.payloadHash !== expectedPayloadHash) {
          throw new TopupError('REQUEST_PAYLOAD_MISMATCH', 'Conflicting payload for existing requestId');
        }
        if (attemptSnap.exists) {
          const attempt = attemptSnap.data();
          return {
            topupId: attempt.topupId,
            orderId: attempt.orderId,
            amountPaise: attempt.amountPaise,
            currency: 'INR',
            keyId: attempt.keyId,
            status: attempt.status,
            idempotent: true,
          };
        }
      }
      return null;
    }

    // Resolve bound retries before contacting the provider. External order
    // creation stays outside Firestore's retryable transaction callback.
    const existing = await db.runTransaction(readInitiation);
    if (existing) return existing;
    let order;
    try {
      if (!razorpayClient || typeof razorpayClient.createOrder !== 'function') {
        throw new Error('Provider order creation is unavailable');
      }
      order = await razorpayClient.createOrder({
        amount: amountPaise,
        currency: 'INR',
        receipt: topupId,
        notes: { driverId: driverUid, topupId, requestId },
      });
      // Older injected provider stubs may return only the order entity; the
      // configured public key remains valid checkout identity in that case.
      const keyId = order?.keyId || process.env.RAZORPAY_KEY_ID;
      if (!order || typeof order.id !== 'string' || !order.id ||
          typeof keyId !== 'string' || !keyId) {
        throw new Error('Provider order identity is unavailable');
      }
      order = { ...order, keyId };
    } catch (_) {
      throw new TopupError('PROVIDER_INITIATION_FAILED', 'Provider order creation failed');
    }

    return await db.runTransaction(async tx => {
      const retry = await readInitiation(tx);
      if (retry) return retry;

      const nowMs = now().getTime();
      const at = timestamp(nowMs);
      const orderId = order.id;
      const keyId = order.keyId;

      tx.create(attemptRef, {
        topupId,
        driverId: driverUid,
        amountPaise,
        requestId,
        orderId,
        keyId,
        currency: 'INR',
        status: 'pending',
        paymentId: null,
        failureReason: null,
        createdAt: at,
        updatedAt: at,
      });

      tx.create(receiptRef, {
        requestId,
        status: 'completed',
        type: 'wallet_topup_initiation',
        ownerToken: null,
        claimedAt: at,
        leaseUntil: null,
        processedAt: at,
        actorUid: driverUid,
        operation: 'initiate_topup',
        resourceId: topupId,
        payloadHash: expectedPayloadHash,
        result: {
          topupId,
          orderId,
          keyId,
          amountPaise,
          currency: 'INR',
        },
      });

      return {
        topupId,
        orderId,
        amountPaise,
        currency: 'INR',
        keyId,
        status: 'pending',
      };
    });
  }

  async function reconcileTopupPayment({
    topupId,
    orderId,
    paymentId,
    amountPaise,
    driverId,
    paymentStatus = 'captured',
  } = {}) {
    if (typeof topupId !== 'string' || !topupId || topupId.includes('/')) {
      throw new TopupError('INVALID_ARGUMENT', 'Invalid topupId');
    }
    if (typeof orderId !== 'string' || !orderId || orderId.includes('/')) {
      throw new TopupError('INVALID_ARGUMENT', 'Invalid orderId');
    }
    if (typeof paymentId !== 'string' || !paymentId || paymentId.includes('/')) {
      throw new TopupError('INVALID_ARGUMENT', 'Invalid paymentId');
    }
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new TopupError('INVALID_ARGUMENT', 'amountPaise must be a positive integer');
    }

    const attemptRef = db.collection('wallet_topup_attempts').doc(topupId);
    const paymentBindingRef = db.collection('processed_payments').doc(paymentId);

    return await db.runTransaction(async tx => {
      const [attemptSnap, paymentSnap] = await Promise.all([
        tx.get(attemptRef),
        tx.get(paymentBindingRef),
      ]);

      if (!attemptSnap.exists) {
        throw new TopupError('TOPUP_ATTEMPT_NOT_FOUND', 'Top-up attempt document does not exist');
      }

      const attempt = attemptSnap.data();
      const operationId = 'wallet_topup:' + attempt.driverId + ':' + attempt.orderId;
      const ledgerRef = db.collection('wallet_entries').doc(operationId);
      const ledgerSnap = await tx.get(ledgerRef);

      // Exact binding verification MUST execute BEFORE terminal status return
      if (driverId && attempt.driverId !== driverId) {
        throw new TopupError('DRIVER_MISMATCH', 'driverId does not match top-up attempt');
      }
      if (attempt.orderId !== orderId) {
        throw new TopupError('ORDER_MISMATCH', 'orderId does not match top-up attempt');
      }
      if (attempt.amountPaise !== amountPaise) {
        throw new TopupError('AMOUNT_MISMATCH', 'amountPaise does not match top-up attempt');
      }
      if (attempt.paymentId && attempt.paymentId !== paymentId) {
        throw new TopupError('PAYMENT_ID_MISMATCH', 'paymentId does not match top-up attempt');
      }

      // Payment binding check: prevent reusing paymentId across different driver or order
      if (paymentSnap.exists) {
        const binding = paymentSnap.data();
        if (binding.driverId !== attempt.driverId || binding.orderId !== attempt.orderId || (binding.topupId && binding.topupId !== topupId)) {
          throw new TopupError('PAYMENT_BINDING_CONFLICT', 'paymentId was already used for another driver or order');
        }
      }

      // Duplicate webhook race / idempotency check (after binding validation)
      if (attempt.status === 'credited') {
        const driverSnap = await tx.get(db.collection('drivers').doc(attempt.driverId));
        return {
          credited: true,
          idempotent: true,
          topupId,
          orderId: attempt.orderId,
          paymentId: attempt.paymentId || paymentId,
          amountPaise: attempt.amountPaise,
          balanceAfterPaise: driverSnap.exists ? driverSnap.data().walletBalance : null,
          operationId,
        };
      }

      if (attempt.status === 'failed') {
        return {
          credited: false,
          idempotent: true,
          topupId,
          orderId: attempt.orderId,
          reason: attempt.failureReason || 'previously_failed',
        };
      }

      const nowMs = now().getTime();
      const at = timestamp(nowMs);

      // If payment failed or was cancelled by provider
      if (paymentStatus !== 'captured') {
        tx.update(attemptRef, {
          status: 'failed',
          paymentId,
          failureReason: paymentStatus,
          updatedAt: at,
        });
        return {
          credited: false,
          topupId,
          orderId,
          paymentId,
          reason: paymentStatus,
        };
      }

      // Payment is captured and verified
      const driverRef = db.collection('drivers').doc(attempt.driverId);
      const driverSnap = await tx.get(driverRef);
      if (!driverSnap.exists) {
        throw new TopupError('DRIVER_NOT_FOUND', 'Driver document does not exist');
      }

      const driver = driverSnap.data();
      // Fail closed on any malformed or non-safe existing wallet balance (P4-D024/P4-D021 boundary)
      if (typeof driver.walletBalance !== 'number' || !Number.isSafeInteger(driver.walletBalance)) {
        throw new TopupError('MALFORMED_WALLET_STATE', 'Driver walletBalance is malformed or not a safe integer');
      }
      if (driver.walletBalance < 0) {
        throw new TopupError('MALFORMED_WALLET_STATE', 'Driver walletBalance cannot be negative');
      }

      const balanceBefore = driver.walletBalance;
      const balanceAfterBig = BigInt(balanceBefore) + BigInt(amountPaise);
      if (balanceAfterBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new TopupError('WALLET_OVERFLOW', 'Wallet balance addition would overflow safe integer');
      }
      const balanceAfterPaise = Number(balanceAfterBig);

      // Ledger uniqueness check
      if (ledgerSnap.exists) {
        throw new TopupError('LEDGER_ALREADY_EXISTS', 'Immutable ledger entry already exists');
      }

      // Atomic multi-document write:
      // 1. Update drivers/{driverId} with incremented walletBalance
      tx.update(driverRef, {
        walletBalance: balanceAfterPaise,
        updatedAt: at,
      });

      // 2. Update wallet_topup_attempts/{topupId} with credited status
      tx.update(attemptRef, {
        status: 'credited',
        paymentId,
        creditedAt: at,
        updatedAt: at,
      });

      // 3. Create immutable ledger entry in authoritative top-level wallet_entries
      tx.create(ledgerRef, {
        operationId,
        type: 'wallet_topup',
        driverId: attempt.driverId,
        topupId,
        orderId,
        paymentId,
        amountPaise,
        deltaPaise: amountPaise,
        balanceBeforePaise: balanceBefore,
        balanceAfterPaise,
        sourceRequestId: attempt.requestId,
        status: 'credited',
        createdAt: at,
      });

      // 4. Record payment binding to prevent reuse
      if (!paymentSnap.exists) {
        tx.create(paymentBindingRef, {
          paymentId,
          driverId: attempt.driverId,
          orderId: attempt.orderId,
          topupId,
          createdAt: at,
        });
      }

      return {
        credited: true,
        topupId,
        orderId,
        paymentId,
        amountPaise,
        balanceAfterPaise,
        operationId,
      };
    });
  }

  return {
    initiateWalletTopup,
    reconcileTopupPayment,
  };
}

let defaultManager;
function getDefaultWalletTopupManager() {
  if (!defaultManager) {
    defaultManager = createWalletTopupManager();
  }
  return defaultManager;
}

function createInitiateWalletTopupCallable({ topupManager } = {}) {
  const handler = async request => {
    const manager = topupManager || getDefaultWalletTopupManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    const data = request.data || {};
    const { amountPaise, requestId } = data;
    try {
      return await manager.initiateWalletTopup({ amountPaise, requestId, driverUid });
    } catch (error) {
      if (error instanceof TopupError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_AMOUNT' || error.code === 'INVALID_REQUEST_ID') {
          httpsCode = 'invalid-argument';
        } else if (error.code === 'UNAUTHENTICATED') {
          httpsCode = 'unauthenticated';
        } else if (error.code === 'DRIVER_NOT_FOUND') {
          httpsCode = 'not-found';
        } else if (error.code === 'REQUEST_PAYLOAD_MISMATCH' || error.code === 'REQUEST_BINDING_CONFLICT') {
          httpsCode = 'invalid-argument';
        }
        throw new HttpsError(httpsCode, error.code, { code: error.code });
      }
      throw error;
    }
  };
  const fn = onCall({ secrets: ['RAZORPAY_KEY_SECRET'] }, handler);
  fn.run = handler;
  return fn;
}

function createSimulateWalletTopupPaymentCallable({ topupManager } = {}) {
  const handler = async request => {
    const manager = topupManager || getDefaultWalletTopupManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const data = request.data || {};
    const { topupId, orderId, paymentId, amountPaise, paymentStatus } = data;
    try {
      return await manager.reconcileTopupPayment({
        topupId,
        orderId,
        paymentId: paymentId || ('pay_test_' + crypto.randomBytes(8).toString('hex')),
        amountPaise,
        paymentStatus: paymentStatus || 'captured',
      });
    } catch (error) {
      if (error instanceof TopupError) {
        let httpsCode = 'failed-precondition';
        if (error.code === 'INVALID_ARGUMENT' || error.code === 'ORDER_MISMATCH' || error.code === 'AMOUNT_MISMATCH') {
          httpsCode = 'invalid-argument';
        } else if (error.code === 'TOPUP_ATTEMPT_NOT_FOUND' || error.code === 'DRIVER_NOT_FOUND') {
          httpsCode = 'not-found';
        }
        throw new HttpsError(httpsCode, error.code, { code: error.code });
      }
      throw error;
    }
  };
  const fn = onCall(handler);
  fn.run = handler;
  return fn;
}

const initiateWalletTopup = createInitiateWalletTopupCallable();
const simulateWalletTopupPayment = createSimulateWalletTopupPaymentCallable();

module.exports = {
  createWalletTopupManager,
  getDefaultWalletTopupManager,
  createInitiateWalletTopupCallable,
  createSimulateWalletTopupPaymentCallable,
  initiateWalletTopup,
  simulateWalletTopupPayment,
  TopupError,
};
