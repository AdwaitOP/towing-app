'use strict';

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

module.exports = { DispatchError, POLICY_KEYS, nonnegative, positive, finiteNonnegative, exactKeys,
  absent, boundedCode, timestampMillis, validCoords, driverCoords, validateDispatchConfig, materializeWorkflow,
  validatePaidJob, assertNoCancellation, assertAuthority, driverEligibility, validateRun, validateActiveOfferRun };
