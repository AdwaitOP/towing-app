'use strict';

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getIstMonthString } = require('../utils/date');
const { validateDispatchConfig, nonnegative, timestampMillis, assertAuthority } = require('../dispatch/dispatchValidation');

class UsageAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'UsageAuthorizationError';
    this.code = code;
  }
}

function validateCounter(data) {
  if (!data || ['olaMapsMatrixRequests', 'olaMapsMatrixPairs', 'whatsappTemplateSends', 'softCapWhatsapp']
    .some(field => !nonnegative(data[field])) || !Number.isFinite(timestampMillis(data.updatedAt))) {
    throw new UsageAuthorizationError('USAGE_COUNTER_INVALID');
  }
  return data;
}

function createUsageCounterService({ db = getFirestore(), TimestampClass = Timestamp, now = () => new Date() } = {}) {
  // No caller cap or caller transaction: current authorization and counters
  // always share this retryable Firestore transaction.
  async function reserveOlaMatrixUsage({ plannedPairs, dispatchClaim }) {
    if (!Number.isSafeInteger(plannedPairs) || plannedPairs <= 0) throw new UsageAuthorizationError('USAGE_PAIRS_INVALID');
    if (dispatchClaim && (typeof dispatchClaim.jobId !== 'string' || !dispatchClaim.jobId || dispatchClaim.jobId.includes('/') ||
      typeof dispatchClaim.ownerToken !== 'string' || !dispatchClaim.ownerToken)) throw new UsageAuthorizationError('USAGE_AUTHORIZATION_FAILED');
    return db.runTransaction(async tx => {
      const instant = now(); // Recomputed on callback retry, including month rollover.
      const monthKey = getIstMonthString(instant);
      const counterRef = db.collection('usage_counters').doc(monthKey);
      const configSnap = await tx.get(db.collection('dispatch_config').doc('main'));
      const counterSnap = await tx.get(counterRef);
      if (dispatchClaim) {
        const jobSnap = await tx.get(db.collection('jobs').doc(dispatchClaim.jobId));
        assertAuthority(jobSnap.exists ? jobSnap.data() : {}, dispatchClaim.ownerToken, now().getTime());
      }
      const config = validateDispatchConfig(configSnap.exists ? configSnap.data() : null);
      const current = counterSnap.exists ? validateCounter(counterSnap.data()) : {
        olaMapsMatrixRequests: 0, olaMapsMatrixPairs: 0, whatsappTemplateSends: 0, softCapWhatsapp: 900,
      };
      const cap = config.olaMonthlyPairCap;
      if (cap === null) return { authorized: false, reason: 'OLA_DISABLED', monthKey };
      if (current.olaMapsMatrixRequests === Number.MAX_SAFE_INTEGER ||
          plannedPairs > Number.MAX_SAFE_INTEGER - current.olaMapsMatrixPairs) {
        throw new UsageAuthorizationError('USAGE_COUNTER_OVERFLOW');
      }
      if (plannedPairs > cap - current.olaMapsMatrixPairs) {
        return { authorized: false, reason: 'CAP_EXCEEDED', monthKey, currentPairs: current.olaMapsMatrixPairs, plannedPairs, cap };
      }
      const next = {
        olaMapsMatrixRequests: current.olaMapsMatrixRequests + 1,
        olaMapsMatrixPairs: current.olaMapsMatrixPairs + plannedPairs,
        updatedAt: TimestampClass.fromMillis(instant.getTime()),
      };
      if (counterSnap.exists) tx.update(counterRef, next);
      else tx.create(counterRef, { ...current, ...next });
      return { authorized: true, monthKey, currentPairs: next.olaMapsMatrixPairs, currentRequests: next.olaMapsMatrixRequests, cap };
    });
  }

  async function getMonthlyUsage(monthKey = getIstMonthString(now())) {
    const snap = await db.collection('usage_counters').doc(monthKey).get();
    return snap.exists ? { monthKey, ...validateCounter(snap.data()) } : {
      monthKey, olaMapsMatrixRequests: 0, olaMapsMatrixPairs: 0, whatsappTemplateSends: 0, softCapWhatsapp: 900, updatedAt: null,
    };
  }
  return { reserveOlaMatrixUsage, getMonthlyUsage };
}

module.exports = { UsageAuthorizationError, createUsageCounterService };
