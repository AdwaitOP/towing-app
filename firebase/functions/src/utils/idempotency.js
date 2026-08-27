'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const DEFAULT_LEASE_MS = 120000;

class IdempotencyError extends Error {
  constructor(message, status = 503, code = 'IDEMPOTENCY_CONFLICT') {
    super(message);
    this.name = 'IdempotencyError';
    this.status = status;
    this.code = code;
  }
}

class OwnershipLostError extends IdempotencyError {
  constructor(message = 'Idempotency lease ownership was lost') {
    super(message, 503, 'OWNERSHIP_LOST');
    this.name = 'OwnershipLostError';
  }
}

function createIdempotencyService({
  db = getFirestore(),
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  leaseMs = DEFAULT_LEASE_MS,
  TimestampClass = Timestamp,
} = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('Firestore is required');
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be positive');

  async function claimLease(identity, type) {
    assertIdentity(identity, type);
    const ownerToken = randomUUID();
    const ref = db.collection('processed_requests').doc(identity);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const nowMs = now();
      if (snapshot.exists) {
        const data = snapshot.data();
        if (data.type !== type) {
          throw new IdempotencyError('Idempotency identity was used for another request type', 409);
        }
        if (data.status === 'completed') {
          if (!data.processedAt) {
            throw new IdempotencyError('Completed idempotency record is malformed');
          }
          return { completed: true, ownerToken: null };
        }
        if (
          data.status !== 'in_progress' ||
          typeof data.ownerToken !== 'string' ||
          !data.ownerToken ||
          !Number.isFinite(timestampMillis(data.leaseUntil))
        ) {
          throw new IdempotencyError('Idempotency record is malformed');
        }
        if (timestampMillis(data.leaseUntil) > nowMs) {
          throw new IdempotencyError('Request is currently being processed', 503);
        }
      }
      const claimedAt = TimestampClass.fromMillis(nowMs);
      transaction.set(ref, {
        status: 'in_progress',
        type,
        ownerToken,
        claimedAt,
        leaseUntil: TimestampClass.fromMillis(nowMs + leaseMs),
      });
      return { completed: false, ownerToken };
    });
  }

  async function markCompleted(identity, ownerToken) {
    const ref = db.collection('processed_requests').doc(identity);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new OwnershipLostError('Idempotency lease no longer exists');
      const data = snapshot.data();
      if (data.status === 'completed') {
        if (data.ownerToken !== ownerToken) throw new OwnershipLostError();
        return false;
      }
      assertOwner(data, ownerToken);
      transaction.update(ref, {
        status: 'completed',
        processedAt: TimestampClass.fromMillis(now()),
        leaseUntil: null,
      });
      return true;
    });
  }

  async function markFailed(identity, ownerToken) {
    const ref = db.collection('processed_requests').doc(identity);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      const data = snapshot.data();
      if (data.status !== 'in_progress' || data.ownerToken !== ownerToken) return false;
      transaction.delete(ref);
      return true;
    });
  }

  async function assertLeaseOwner(identity, ownerToken) {
    const snapshot = await db.collection('processed_requests').doc(identity).get();
    if (!snapshot.exists) throw new OwnershipLostError();
    const data = snapshot.data();
    assertOwner(data, ownerToken);
    if (timestampMillis(data.leaseUntil) <= now()) throw new OwnershipLostError('Idempotency lease expired');
    return data;
  }

  async function executeIdempotent(identity, type, operationFn) {
    let claim;
    try {
      claim = await claimLease(identity, type);
    } catch (error) {
      if (error instanceof IdempotencyError) {
        return { status: error.status, message: error.message, completed: false };
      }
      throw error;
    }
    if (claim.completed) {
      return { status: 200, message: 'Already processed', completed: true };
    }
    try {
      const value = await operationFn(claim.ownerToken);
      await markCompleted(identity, claim.ownerToken);
      return { status: 200, message: 'Success', completed: true, value };
    } catch (error) {
      try {
        await markFailed(identity, claim.ownerToken);
      } catch (releaseError) {
        console.error('Failed to release owned idempotency lease', releaseError);
      }
      if (error instanceof IdempotencyError) {
        return { status: error.status, message: error.message, completed: false };
      }
      throw error;
    }
  }

  return { claimLease, markCompleted, markFailed, assertLeaseOwner, executeIdempotent };
}

function assertIdentity(identity, type) {
  if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('identity is required');
  if (identity.includes('/')) throw new TypeError('identity cannot contain a slash');
  if (typeof type !== 'string' || !type.trim()) throw new TypeError('request type is required');
}

function assertOwner(data, ownerToken) {
  if (!ownerToken || data.status !== 'in_progress' || data.ownerToken !== ownerToken) {
    throw new OwnershipLostError();
  }
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return NaN;
}

const defaultService = createIdempotencyService;

module.exports = {
  DEFAULT_LEASE_MS,
  IdempotencyError,
  OwnershipLostError,
  createIdempotencyService,
  claimLease: (...args) => defaultService().claimLease(...args),
  markCompleted: (...args) => defaultService().markCompleted(...args),
  markFailed: (...args) => defaultService().markFailed(...args),
  executeIdempotent: (...args) => defaultService().executeIdempotent(...args),
};
