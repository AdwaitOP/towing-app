'use strict';

const crypto = require('node:crypto');
const { GeoPoint } = require('firebase-admin/firestore');


// Runtime guards implement the committed Stage 1 contracts. No coercion or
// financial/history repair belongs in a dispatch worker.
class DispatchError extends Error {
  constructor(code, { retryable = false, source = 'dispatch_worker' } = {}) {
    super(code);
    this.name = 'DispatchError';
    this.code = code;
    this.retryable = retryable;
    this.source = source;
  }
}

const POLICY_KEYS = [
  'locationFreshnessSeconds', 'radiusKmSequence', 'maxUniqueCandidatesPerGeneration',
  'maxMatrixShortlistPerRound', 'rankingPrimary', 'rankingSecondary', 'rankingTieBreak', 'olaFailureMode',
];
const WORKFLOW_DEFAULTS = Object.freeze({
  stateVersion: 0, dispatchGeneration: 0, dispatchState: 'ready', dispatchRunId: null,
  dispatchLeaseOwner: null, dispatchLeaseUntil: null, dispatchNextActionAt: null,
  dispatchLastFailure: null, currentOfferId: null, offeredAt: null, acceptedAt: null,
  inProgressAt: null, completedAt: null, commissionDebitEntryId: null,
  cancellationResolutionState: 'none', cancellationResolvedAt: null, cancelledAt: null,
  refundRequestId: null, refundState: 'none', refundNextAttemptAt: null,
});
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
const absent = value => value === undefined || value === null;
const boundedCode = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function timestampMillis(value) {
  try {
    const result = value instanceof Date ? value.getTime() : value?.toMillis?.();
    return Number.isFinite(result) && result > 0 ? result : NaN;
  } catch { return NaN; }
}

function validCoords(coords) {
  return exactKeys(coords, ['lat', 'lng']) &&
    typeof coords.lat === 'number' && Number.isFinite(coords.lat) && Math.abs(coords.lat) <= 90 &&
    typeof coords.lng === 'number' && Number.isFinite(coords.lng) && Math.abs(coords.lng) <= 180;
}

function driverCoords(location) {
  // Driver locations are Firestore GeoPoints; job/offer coordinates are maps.
  if (!(location instanceof GeoPoint)) return null;
  const coords = { lat: location?.latitude, lng: location?.longitude };
  return validCoords(coords) ? coords : null;
}

function validatePolicy(policy) {
  return policy && positive(policy.locationFreshnessSeconds) &&
    Number.isSafeInteger(policy.locationFreshnessSeconds * 1000) &&
    Array.isArray(policy.radiusKmSequence) && policy.radiusKmSequence.length > 0 &&
    policy.radiusKmSequence.every((radius, i, radii) => typeof radius === 'number' &&
      Number.isFinite(radius) && radius > 0 && (i === 0 || radius > radii[i - 1])) &&
    positive(policy.maxUniqueCandidatesPerGeneration) && policy.maxUniqueCandidatesPerGeneration <= 30 &&
    positive(policy.maxMatrixShortlistPerRound) && policy.maxMatrixShortlistPerRound <= 10 &&
    policy.maxMatrixShortlistPerRound <= policy.maxUniqueCandidatesPerGeneration &&
    policy.rankingPrimary === 'ola_eta_seconds' && policy.rankingSecondary === 'ola_distance_meters' &&
    policy.rankingTieBreak === 'driver_uid' && policy.olaFailureMode === 'bounded_retry_then_haversine_degraded';
}

function validateDispatchConfig(config) {
  if (!config || !positive(config.version) || !validatePolicy(config) ||
      !(config.olaMonthlyPairCap === null || positive(config.olaMonthlyPairCap)) ||
      !Number.isFinite(timestampMillis(config.updatedAt))) {
    throw new DispatchError('CONFIG_INVALID', { source: 'dispatch_config' });
  }
  return config;
}

function materializeWorkflow(job) {
  const patch = {};
  for (const [field, value] of Object.entries(WORKFLOW_DEFAULTS)) {
    if (!Object.hasOwn(job, field)) patch[field] = value;
  }
  // null/not_started are explicitly permitted legacy workflow states.
  if (job.dispatchState === null || job.dispatchState === 'not_started') patch.dispatchState = 'ready';
  return { job: { ...job, ...patch }, patch };
}

function assertNoCancellation(job) {
  if (['cancellationRequestedAt', 'cancellationResolvedAt', 'cancelledAt', 'cancelledBy',
    'cancellationReason'].some(key => !absent(job[key])) || job.cancellationResolutionState !== 'none') {
    throw new DispatchError('CANCELLATION_PRECEDENCE');
  }
}

function validatePaidJob(job) {
  assertNoCancellation(job);
  if (job.status !== 'pending_offer') throw new DispatchError('JOB_NOT_PENDING');
  if (!['flatbed', 'pulling'].includes(job.requestedTruckType) || !validCoords(job.pickupCoords) ||
      !validCoords(job.destCoords) || !nonnegative(job.bookingFeePaise) ||
      !nonnegative(job.driverCommissionPaise) || !nonnegative(job.estimatedFarePaise) ||
      !finiteNonnegative(job.distanceKm) || ![1, 2, 3].includes(job.pricingTier) ||
      !['phone', 'whatsapp'].includes(job.channel) || !/^\+[1-9]\d{7,14}$/.test(job.customerPhone) ||
      !text(job.razorpayPaymentId) || !text(job.razorpayPaymentLinkId) ||
      !Number.isFinite(timestampMillis(job.paymentConfirmedAt)) ||
      !Number.isFinite(timestampMillis(job.createdAt)) || !Number.isFinite(timestampMillis(job.updatedAt))) {
    throw new DispatchError('JOB_INVALID');
  }
  // Phase 3 explicitly creates these two guards. Missing is not null.
  if (job.assignedDriver !== null || job.offeredTo !== null ||
      ['currentOfferId', 'offeredAt', 'offerExpiresAt', 'acceptedAt', 'inProgressAt', 'completedAt',
        'commissionDebitEntryId'].some(key => !absent(job[key]))) throw new DispatchError('ASSIGNMENT_INVALID');
  if (job.refundState !== 'none' || ['refundRequestId', 'refundNextAttemptAt', 'razorpayRefundId',
    'refundedAmountPaise', 'refundConfirmedAt'].some(key => !absent(job[key]))) throw new DispatchError('REFUND_STATE_INVALID');
  if (!absent(job.forfeitedAmount) && !nonnegative(job.forfeitedAmount)) throw new DispatchError('JOB_INVALID');
  if (!nonnegative(job.stateVersion) || job.stateVersion === Number.MAX_SAFE_INTEGER ||
      !nonnegative(job.dispatchGeneration) ||
      (job.dispatchGeneration === 0 ? job.dispatchRunId !== null : job.dispatchRunId !== String(job.dispatchGeneration)) ||
      !['ready', 'claimed', 'selecting', 'retry_wait', 'operational_hold'].includes(job.dispatchState)) {
    throw new DispatchError('DISPATCH_STATE_INVALID');
  }
  const owned = ['claimed', 'selecting'].includes(job.dispatchState);
  if (owned ? (!text(job.dispatchLeaseOwner) || !Number.isFinite(timestampMillis(job.dispatchLeaseUntil))) :
    (job.dispatchLeaseOwner !== null || job.dispatchLeaseUntil !== null)) throw new DispatchError('DISPATCH_STATE_INVALID');
  if (!absent(job.dispatchNextActionAt) && !Number.isFinite(timestampMillis(job.dispatchNextActionAt))) {
    throw new DispatchError('DISPATCH_STATE_INVALID');
  }
  if (job.dispatchState === 'retry_wait' && !Number.isFinite(timestampMillis(job.dispatchNextActionAt))) {
    throw new DispatchError('DISPATCH_STATE_INVALID');
  }
  const failure = job.dispatchLastFailure;
  if (failure !== null && (!exactKeys(failure, ['code', 'source', 'retryable', 'occurredAt']) ||
    !boundedCode(failure.code) || !boundedCode(failure.source) || typeof failure.retryable !== 'boolean' ||
    !Number.isFinite(timestampMillis(failure.occurredAt)))) throw new DispatchError('DISPATCH_STATE_INVALID');
  return job;
}

function assertAuthority(job, ownerToken, nowMs) {
  if (job.dispatchLeaseOwner !== ownerToken) throw new DispatchError('LEASE_DISPLACED');
  if (!(timestampMillis(job.dispatchLeaseUntil) > nowMs)) throw new DispatchError('LEASE_EXPIRED');
  validatePaidJob(job);
}

function driverEligibility(driver, job, policy, nowMs) {
  if (!driver || typeof driver.isOnDuty !== 'boolean' ||
      !['approved', 'pending', 'rejected'].includes(driver.verificationStatus) ||
      typeof driver.canFlatbed !== 'boolean' || typeof driver.canPulling !== 'boolean' ||
      !(driver.activeJobId === null || text(driver.activeJobId)) ||
      !(driver.activeOfferId === null || text(driver.activeOfferId)) || !nonnegative(driver.walletBalance) ||
      !(driver.bannedUntil === null || Number.isFinite(timestampMillis(driver.bannedUntil))) ||
      !driverCoords(driver.location) || !Number.isFinite(timestampMillis(driver.locationUpdatedAt)) ||
      timestampMillis(driver.locationUpdatedAt) > nowMs) {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (!driver.isOnDuty || driver.verificationStatus !== 'approved' ||
      driver[job.requestedTruckType === 'flatbed' ? 'canFlatbed' : 'canPulling'] !== true ||
      driver.activeJobId !== null || driver.activeOfferId !== null ||
      driver.walletBalance < job.driverCommissionPaise || timestampMillis(driver.bannedUntil) > nowMs) {
    return 'driver_ineligible';
  }
  if (nowMs - timestampMillis(driver.locationUpdatedAt) > policy.locationFreshnessSeconds * 1000) {
    return 'driver_location_stale';
  }
  return null;
}

function validateRun(run, job, jobId, runId) {
  const fail = () => { throw new DispatchError('RUN_INVALID'); };
  if (!run || run.jobId !== jobId || run.generation !== job.dispatchGeneration ||
      runId !== job.dispatchRunId || runId !== String(run.generation) || !positive(run.generation) ||
      run.status !== 'active' || run.finalizedAt !== null || run.currentOfferId !== null ||
      !positive(run.policyVersion) || !exactKeys(run.policySnapshot, POLICY_KEYS) ||
      !validatePolicy(run.policySnapshot) || !Array.isArray(run.candidates) ||
      run.candidates.length > run.policySnapshot.maxUniqueCandidatesPerGeneration ||
      !nonnegative(run.nextCandidateIndex) || run.nextCandidateIndex > run.candidates.length ||
      !Number.isFinite(timestampMillis(run.createdAt)) || !Number.isFinite(timestampMillis(run.updatedAt))) fail();
  const ids = new Set();
  const rounds = new Map();
  const attempted = [];
  let lastRound = -1;
  for (let i = 0; i < run.candidates.length; i++) {
    const c = run.candidates[i];
    if (!exactKeys(c, ['driverId', 'roundIndex', 'haversineDistanceKm', 'matrixEtaSeconds',
      'matrixDistanceMeters', 'rankingMode', 'outcome', 'reasonCode']) || !text(c.driverId) ||
      c.driverId.includes('/') || ids.has(c.driverId) || !nonnegative(c.roundIndex) ||
      c.roundIndex < lastRound || c.roundIndex >= run.policySnapshot.radiusKmSequence.length ||
      !finiteNonnegative(c.haversineDistanceKm) ||
      c.haversineDistanceKm > run.policySnapshot.radiusKmSequence[c.roundIndex] ||
      !(c.reasonCode === null || boundedCode(c.reasonCode))) fail();
    lastRound = c.roundIndex;
    ids.add(c.driverId);
    rounds.set(c.roundIndex, (rounds.get(c.roundIndex) || 0) + 1);
    if (rounds.get(c.roundIndex) > run.policySnapshot.maxMatrixShortlistPerRound) fail();
    if (c.rankingMode === 'ola') {
      if (!finiteNonnegative(c.matrixEtaSeconds) || !finiteNonnegative(c.matrixDistanceMeters)) fail();
    } else if (c.rankingMode !== 'haversine_degraded' || c.matrixEtaSeconds !== null || c.matrixDistanceMeters !== null) fail();
    if (i >= run.nextCandidateIndex ? c.outcome !== 'pending' :
      !['declined', 'expired', 'driver_cancelled', 'skipped'].includes(c.outcome)) fail();
    if (['declined', 'expired', 'driver_cancelled'].includes(c.outcome)) attempted.push(c.driverId);
    if (c.outcome === 'skipped' && !['driver_ineligible', 'driver_location_stale', 'driver_outside_radius'].includes(c.reasonCode)) fail();
  }
  for (const list of [run.attemptedDriverIds, run.excludedDriverIds]) {
    if (!Array.isArray(list) || list.length > 30 || new Set(list).size !== list.length || list.some(id => !ids.has(id))) fail();
  }
  if (attempted.length !== run.attemptedDriverIds.length || attempted.some(id => !run.attemptedDriverIds.includes(id)) ||
    run.excludedDriverIds.some(id => !run.attemptedDriverIds.includes(id)) ||
    run.candidates.some(c => c.outcome === 'driver_cancelled' && !run.excludedDriverIds.includes(c.driverId))) fail();
  return run;
}

function validateActiveOfferRun(run, job, offer, jobId, offerId, dispatchGeneration) {
  if (!run || typeof run !== 'object') throw new DispatchError('RUN_INVALID');
  if (run.jobId !== jobId || run.generation !== dispatchGeneration) {
    throw new DispatchError('RUN_GENERATION_MISMATCH');
  }
  if (run.status !== 'active' || run.currentOfferId !== offerId || run.finalizedAt !== null) {
    throw new DispatchError('RUN_CONFLICT');
  }
  if (!positive(run.policyVersion) || !exactKeys(run.policySnapshot, POLICY_KEYS) ||
      !validatePolicy(run.policySnapshot) || !Array.isArray(run.candidates) ||
      run.candidates.length > run.policySnapshot.maxUniqueCandidatesPerGeneration ||
      run.candidates.length > 30 ||
      !Array.isArray(run.attemptedDriverIds) || !Array.isArray(run.excludedDriverIds) ||
      run.attemptedDriverIds.length > 30 || run.excludedDriverIds.length > 30 ||
      !Number.isFinite(timestampMillis(run.createdAt)) || !Number.isFinite(timestampMillis(run.updatedAt))) {
    throw new DispatchError('RUN_INVALID');
  }
  if (new Set(run.attemptedDriverIds).size !== run.attemptedDriverIds.length ||
      new Set(run.excludedDriverIds).size !== run.excludedDriverIds.length) {
    throw new DispatchError('RUN_INVALID');
  }

  const k = offer.candidateIndex;
  if (!nonnegative(k) || k >= run.candidates.length) {
    throw new DispatchError('CANDIDATE_INDEX_OUT_OF_BOUNDS');
  }
  // Exact cursor relation: in Stage 2 runtime, nextCandidateIndex == candidateIndex + 1
  if (!Number.isSafeInteger(run.nextCandidateIndex) || run.nextCandidateIndex !== k + 1) {
    throw new DispatchError('RUN_CURSOR_INVALID');
  }

  const ids = new Set();
  const expectedAttempted = [];
  let lastRound = -1;

  for (let i = 0; i < run.candidates.length; i++) {
    const c = run.candidates[i];
    if (!exactKeys(c, ['driverId', 'roundIndex', 'haversineDistanceKm', 'matrixEtaSeconds',
      'matrixDistanceMeters', 'rankingMode', 'outcome', 'reasonCode']) || !text(c.driverId) ||
      c.driverId.includes('/') || ids.has(c.driverId) || !nonnegative(c.roundIndex) ||
      c.roundIndex < lastRound || c.roundIndex >= run.policySnapshot.radiusKmSequence.length ||
      !finiteNonnegative(c.haversineDistanceKm) ||
      c.haversineDistanceKm > run.policySnapshot.radiusKmSequence[c.roundIndex] ||
      !(c.reasonCode === null || boundedCode(c.reasonCode))) {
      throw new DispatchError('RUN_INVALID');
    }
    lastRound = c.roundIndex;
    ids.add(c.driverId);

    if (c.rankingMode === 'ola') {
      if (!finiteNonnegative(c.matrixEtaSeconds) || !finiteNonnegative(c.matrixDistanceMeters)) {
        throw new DispatchError('RUN_INVALID');
      }
    } else if (c.rankingMode !== 'haversine_degraded' || c.matrixEtaSeconds !== null || c.matrixDistanceMeters !== null) {
      throw new DispatchError('RUN_INVALID');
    }

    if (i < k) {
      // Preceding candidates must have legal terminal non-accepted outcomes
      if (!['declined', 'expired', 'driver_cancelled', 'skipped'].includes(c.outcome)) {
        throw new DispatchError('RUN_INVALID');
      }
      if (c.outcome === 'skipped') {
        if (!['driver_ineligible', 'driver_location_stale', 'driver_outside_radius'].includes(c.reasonCode)) {
          throw new DispatchError('RUN_INVALID');
        }
      } else {
        expectedAttempted.push(c.driverId);
      }
    } else if (i === k) {
      // Current offered candidate
      if (c.driverId !== offer.driverId) {
        throw new DispatchError('CANDIDATE_DRIVER_MISMATCH');
      }
      if (c.outcome !== 'offered') {
        throw new DispatchError('CANDIDATE_OUTCOME_CONFLICT');
      }
      if (c.reasonCode !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      expectedAttempted.push(c.driverId);
    } else {
      // Future candidates (i > k) must remain pending and unattempted
      if (c.outcome !== 'pending' || c.reasonCode !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      if (run.attemptedDriverIds.includes(c.driverId)) {
        throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
      }
    }
  }

  // Attempted history validation
  if (run.attemptedDriverIds.length !== expectedAttempted.length) {
    throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
  }
  for (let idx = 0; idx < expectedAttempted.length; idx++) {
    if (run.attemptedDriverIds[idx] !== expectedAttempted[idx]) {
      throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
    }
  }
  const currentOfferedCount = run.attemptedDriverIds.filter(id => id === offer.driverId).length;
  if (currentOfferedCount !== 1) {
    throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
  }

  // Excluded history validation
  if (run.excludedDriverIds.some(id => !ids.has(id) || !run.attemptedDriverIds.includes(id))) {
    throw new DispatchError('RUN_INVALID');
  }
  for (const c of run.candidates) {
    if (c.outcome === 'driver_cancelled' && !run.excludedDriverIds.includes(c.driverId)) {
      throw new DispatchError('RUN_INVALID');
    }
  }

  return run;
}

function validateAcceptanceCancellationProvenance(job, offer) {
  const hasReq = !absent(job.cancellationRequestedAt);
  const hasResAt = !absent(job.cancellationResolvedAt);
  const hasCanAt = !absent(job.cancelledAt);
  const hasCanBy = !absent(job.cancelledBy);
  const hasReason = !absent(job.cancellationReason);
  const resState = job.cancellationResolutionState;

  const isCleanNoCancellation = !hasReq && !hasResAt && !hasCanAt && !hasCanBy && !hasReason &&
    resState === 'none' && offer.status !== 'cancelled_customer';

  if (!isCleanNoCancellation) {
    const isLegitCustomerCancel = (hasReq && ['pending', 'resolved_customer_cancelled'].includes(resState)) ||
                                  job.cancelledBy === 'customer' ||
                                  offer.status === 'cancelled_customer';
    if (isLegitCustomerCancel && (hasReq || offer.status === 'cancelled_customer')) {
      throw new DispatchError('CANCELLATION_PRECEDENCE');
    }
    throw new DispatchError('CANCELLATION_PROVENANCE_CONFLICT');
  }
}

function isAuthoritativeTimestamp(val, TimestampClass) {
  if (!val || typeof val !== 'object') return false;
  if (val instanceof Date) return false;
  if (TimestampClass && val instanceof TimestampClass) return true;
  if (typeof val.toMillis === 'function' && typeof val.toDate === 'function') {
    if (Number.isInteger(val.seconds) && Number.isInteger(val.nanoseconds)) {
      return val.nanoseconds >= 0 && val.nanoseconds < 1e9;
    }
    if (val.constructor && val.constructor.name.includes('Timestamp')) {
      return Number.isFinite(val.toMillis());
    }
  }
  return false;
}

function validateAcceptanceDriverEligibility(driver, job, offerId, nowMs, TimestampClass) {
  if (!driver || typeof driver !== 'object') {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (driver.verificationStatus !== 'approved') {
    throw new DispatchError('DRIVER_INELIGIBLE');
  }
  if (driver.isOnDuty !== true) {
    throw new DispatchError('DRIVER_INELIGIBLE');
  }
  if (driver.activeJobId !== null) {
    throw new DispatchError('ACTIVE_JOB_CONFLICT');
  }
  if (driver.activeOfferId !== offerId) {
    throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  }

  // Capability validation
  if (typeof driver.canFlatbed !== 'boolean' || typeof driver.canPulling !== 'boolean') {
    throw new DispatchError('DRIVER_INELIGIBLE');
  }

  if (job.requestedTruckType === 'flatbed') {
    if (driver.canFlatbed !== true) throw new DispatchError('DRIVER_INELIGIBLE');
  } else if (job.requestedTruckType === 'pulling') {
    if (driver.canPulling !== true) throw new DispatchError('DRIVER_INELIGIBLE');
  } else {
    throw new DispatchError('JOB_INVALID');
  }

  // Banned until validation
  if (driver.bannedUntil !== null) {
    if (!isAuthoritativeTimestamp(driver.bannedUntil, TimestampClass)) {
      throw new DispatchError('DRIVER_INVALID');
    }
    const banMs = timestampMillis(driver.bannedUntil);
    if (banMs > nowMs) {
      throw new DispatchError('DRIVER_BANNED');
    }
  }

  // Wallet balance validation
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) {
    throw new DispatchError('WALLET_BALANCE_INVALID');
  }
  if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
    throw new DispatchError('COMMISSION_PAISE_INVALID');
  }
  if (driver.walletBalance < job.driverCommissionPaise) {
    throw new DispatchError('INSUFFICIENT_WALLET_BALANCE');
  }
  return true;
}

function validateCancellationPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  if (!positive(policy.version)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  if (policy.timezone !== 'Asia/Kolkata') {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  if (policy.roundingMode !== 'HALF_UP') {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  const F = policy.free_cancellations_per_month;
  if (!nonnegative(F)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  const B = policy.ban_threshold_count;
  if (!positive(B) || B <= F + 1) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  if (!positive(policy.ban_duration_days)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }

  validateCancellationRamp(policy.forfeit_pct_by_count, F, B, 'CANCELLATION_POLICY_INVALID');
  return policy;
}

function validateCancellationRamp(ramp, F, B, errorCode = 'CANCELLATION_POLICY_INVALID') {
  if (!ramp || typeof ramp !== 'object' || Array.isArray(ramp)) {
    throw new DispatchError(errorCode);
  }
  const expectedKeys = [];
  for (let c = F + 1; c <= B - 1; c++) {
    expectedKeys.push(String(c));
  }
  const actualKeys = Object.keys(ramp);
  if (expectedKeys.length === 0 || actualKeys.length !== expectedKeys.length) {
    throw new DispatchError(errorCode);
  }
  for (const expectedKey of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(ramp, expectedKey)) {
      throw new DispatchError(errorCode);
    }
  }
  for (const k of actualKeys) {
    if (!/^\d+$/.test(k) || String(parseInt(k, 10)) !== k) {
      throw new DispatchError(errorCode);
    }
    const val = ramp[k];
    if (!Number.isSafeInteger(val) || val < 0 || val > 100) {
      throw new DispatchError(errorCode);
    }
  }
  return true;
}

function validateStoredCancellationPolicySnapshot(snapshot, TimestampClass) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  const actualKeys = Object.keys(snapshot).sort();
  const expectedKeys = [
    'banDurationDays',
    'banThresholdCount',
    'capturedAt',
    'forfeitPctByCount',
    'freeCancellationsPerMonth',
    'roundingMode',
    'timezone',
    'version',
  ].sort();
  if (actualKeys.length !== expectedKeys.length || !actualKeys.every((k, i) => k === expectedKeys[i])) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!positive(snapshot.version)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (snapshot.timezone !== 'Asia/Kolkata') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (snapshot.roundingMode !== 'HALF_UP') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!nonnegative(snapshot.freeCancellationsPerMonth)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!positive(snapshot.banThresholdCount)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (snapshot.banThresholdCount <= snapshot.freeCancellationsPerMonth + 1) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!positive(snapshot.banDurationDays)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(snapshot.capturedAt, TimestampClass)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  validateCancellationRamp(
    snapshot.forfeitPctByCount,
    snapshot.freeCancellationsPerMonth,
    snapshot.banThresholdCount,
    'ACCEPTANCE_CONFLICT'
  );
  return true;
}

function validateCleanOfferedJobState(job) {
  if (!job || typeof job !== 'object') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (job.assignedDriver != null ||
      job.acceptedAt != null ||
      job.inProgressAt != null ||
      job.completedAt != null ||
      job.commissionDebitEntryId != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (job.cancelledAt != null ||
      job.cancelledBy != null ||
      job.cancellationReason != null ||
      job.cancellationResolvedAt != null ||
      (job.cancellationResolutionState != null && job.cancellationResolutionState !== 'none')) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (job.refundRequestId != null ||
      (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null ||
      job.razorpayRefundId != null ||
      job.refundConfirmedAt != null ||
      job.refundedAmountPaise != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  return true;
}

function buildCancellationPolicySnapshot(policy, capturedAt, TimestampClass) {
  validateCancellationPolicy(policy);
  if (!isAuthoritativeTimestamp(capturedAt, TimestampClass)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  const F = policy.free_cancellations_per_month;
  const B = policy.ban_threshold_count;
  const forfeitPctByCount = {};
  for (let c = F + 1; c <= B - 1; c++) {
    const k = String(c);
    forfeitPctByCount[k] = policy.forfeit_pct_by_count[k];
  }
  return {
    version: policy.version,
    timezone: policy.timezone,
    roundingMode: policy.roundingMode,
    freeCancellationsPerMonth: policy.free_cancellations_per_month,
    forfeitPctByCount,
    banThresholdCount: policy.ban_threshold_count,
    banDurationDays: policy.ban_duration_days,
    capturedAt,
  };
}

function validateCanonicalAcceptedOccurrence({
  job,
  offer,
  run,
  driver,
  ledger,
  outbox,
  receipt,
  historicalReceipt,
  jobId,
  offerId,
  driverUid,
  requestId,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (job.status !== 'accepted' || job.dispatchState !== 'assigned') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (job.assignedDriver !== driverUid || job.currentOfferId !== offerId) throw new DispatchError('JOB_ALREADY_ASSIGNED');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) throw new DispatchError('ACCEPTANCE_CONFLICT');
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.status !== 'accepted') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.jobId !== jobId || offer.driverId !== driverUid) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.driverCommissionPaise !== job.driverCommissionPaise) throw new DispatchError('ACCEPTANCE_CONFLICT');

  // Policy snapshot on offer
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  // 3. RUN
  if (!run || typeof run !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (run.status !== 'assigned') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (run.currentOfferId !== offerId || run.finalizedAt !== null) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (run.generation !== job.dispatchGeneration) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Array.isArray(run.candidates) || !run.candidates[offer.candidateIndex]) throw new DispatchError('ACCEPTANCE_CONFLICT');
  const candidate = run.candidates[offer.candidateIndex];
  if (candidate.driverId !== driverUid || candidate.outcome !== 'accepted') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (run.nextCandidateIndex !== offer.candidateIndex + 1) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Array.isArray(run.attemptedDriverIds) || !run.attemptedDriverIds.includes(driverUid)) throw new DispatchError('ACCEPTANCE_CONFLICT');
  for (let i = 0; i < run.candidates.length; i++) {
    if (i < offer.candidateIndex) {
      if (run.candidates[i].outcome === 'offered' || run.candidates[i].outcome === 'accepted' || run.candidates[i].outcome === 'pending') {
        throw new DispatchError('ACCEPTANCE_CONFLICT');
      }
    } else if (i > offer.candidateIndex) {
      if (run.candidates[i].outcome !== 'pending') throw new DispatchError('ACCEPTANCE_CONFLICT');
    }
  }

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (driver.activeOfferId !== null || driver.activeJobId !== jobId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');

  // 5. LEDGER
  if (!ledger || typeof ledger !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.acceptRequestId !== ledger.sourceRequestId) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (offer.acceptRequestId !== null && typeof offer.acceptRequestId !== 'string') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (ledger.sourceRequestId !== null && typeof ledger.sourceRequestId !== 'string') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (ledger.operationId !== expectedLedgerId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.driverId !== driverUid || ledger.jobId !== jobId || ledger.offerId !== offerId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.type !== 'commission_debit') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.forfeiturePaise !== 0 || ledger.creditPaise !== 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(ledger.balanceBeforePaise) || ledger.balanceBeforePaise < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(ledger.balanceAfterPaise) || ledger.balanceAfterPaise < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.balanceBeforePaise - job.driverCommissionPaise !== ledger.balanceAfterPaise) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.cancellationPolicyEvidence !== null) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.sourceType !== 'driver' || ledger.actorUid !== driverUid) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(ledger.createdAt, TimestampClass)) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (ledger.sourceRequestId !== null && typeof ledger.sourceRequestId !== 'string') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 6. OUTBOX
  if (!outbox || typeof outbox !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  const expectedOutboxId = 'job_accepted:' + jobId + ':' + offerId;
  if (outbox.eventId !== expectedOutboxId || outbox.eventType !== 'job_accepted') throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (outbox.resourceType !== 'job' || outbox.resourceId !== jobId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (outbox.channel !== 'whatsapp' || outbox.recipientKey !== 'customer:' + jobId) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (outbox.payloadVersion !== 1) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!outbox.payload || typeof outbox.payload !== 'object') throw new DispatchError('ACCEPTANCE_CONFLICT');
  const outboxPayloadKeys = Object.keys(outbox.payload).sort();
  if (outboxPayloadKeys.length !== 3 || outboxPayloadKeys[0] !== 'jobId' || outboxPayloadKeys[1] !== 'jobStatus' || outboxPayloadKeys[2] !== 'refundAmountPaise') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (outbox.payload.jobId !== jobId || outbox.payload.jobStatus !== 'accepted' || outbox.payload.refundAmountPaise !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  const allowedOutboxStates = ['pending', 'in_progress', 'retry_wait', 'sent', 'failed_terminal'];
  if (!allowedOutboxStates.includes(outbox.state)) throw new DispatchError('ACCEPTANCE_CONFLICT');

  // 7. HISTORICAL RECEIPT (if offer.acceptRequestId != null)
  if (offer.acceptRequestId !== null) {
    if (!historicalReceipt || typeof historicalReceipt !== 'object') {
      throw new DispatchError('ACCEPTANCE_CONFLICT');
    }
    if (historicalReceipt.requestId !== offer.acceptRequestId) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (historicalReceipt.status !== 'completed') {
      if (historicalReceipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (historicalReceipt.type !== 'phase4_client_mutation') {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (historicalReceipt.actorUid !== driverUid || historicalReceipt.operation !== 'accept' || historicalReceipt.resourceId !== jobId + ':' + offerId) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    const expectedHistPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
    if (historicalReceipt.payloadHash !== expectedHistPayloadHash) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (!historicalReceipt.result || typeof historicalReceipt.result !== 'object' ||
        historicalReceipt.result.accepted !== true || historicalReceipt.result.jobId !== jobId ||
        historicalReceipt.result.offerId !== offerId || historicalReceipt.result.driverId !== driverUid) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (!isAuthoritativeTimestamp(historicalReceipt.processedAt, TimestampClass) || !isAuthoritativeTimestamp(historicalReceipt.claimedAt, TimestampClass)) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (historicalReceipt.leaseUntil !== null || historicalReceipt.ownerToken !== null) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
  }

  // 8. CURRENT RETRY RECEIPT (if present for requestId)
  if (receipt) {
    if (receipt.requestId !== requestId) throw new DispatchError('REQUEST_BINDING_CONFLICT');
    if (receipt.status !== 'completed') {
      if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (receipt.type !== 'phase4_client_mutation') throw new DispatchError('REQUEST_BINDING_CONFLICT');
    if (receipt.actorUid !== driverUid || receipt.operation !== 'accept' || receipt.resourceId !== jobId + ':' + offerId) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    const expectedPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
    if (receipt.payloadHash !== expectedPayloadHash) throw new DispatchError('REQUEST_BINDING_CONFLICT');
    if (!receipt.result || typeof receipt.result !== 'object' ||
        receipt.result.accepted !== true || receipt.result.jobId !== jobId ||
        receipt.result.offerId !== offerId || receipt.result.driverId !== driverUid) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (!isAuthoritativeTimestamp(receipt.processedAt, TimestampClass) || !isAuthoritativeTimestamp(receipt.claimedAt, TimestampClass)) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
    if (receipt.leaseUntil !== null || receipt.ownerToken !== null) {
      throw new DispatchError('REQUEST_BINDING_CONFLICT');
    }
  }

  return true;
}

module.exports = {
  DispatchError, POLICY_KEYS, nonnegative, positive, finiteNonnegative, exactKeys,
  absent, boundedCode, timestampMillis, validCoords, driverCoords, validateDispatchConfig, materializeWorkflow,
  validatePaidJob, assertNoCancellation, assertAuthority, driverEligibility, validateRun, validateActiveOfferRun,
  validateAcceptanceCancellationProvenance, validateAcceptanceDriverEligibility, validateCancellationPolicy,
  buildCancellationPolicySnapshot, isAuthoritativeTimestamp, validateCanonicalAcceptedOccurrence,
  validateCancellationRamp, validateStoredCancellationPolicySnapshot, validateCleanOfferedJobState,
};
