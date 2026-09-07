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

function validateCanonicalAssignedRun({ run, job, offer, jobId, offerId, driverUid, TimestampClass }) {
  if (!run || typeof run !== 'object') throw new DispatchError('RUN_NOT_FOUND');
  if (run.jobId !== jobId) throw new DispatchError('RUN_GENERATION_MISMATCH');
  if (run.generation !== job.dispatchGeneration) throw new DispatchError('RUN_GENERATION_MISMATCH');
  if (job.dispatchRunId !== String(job.dispatchGeneration)) throw new DispatchError('JOB_RUN_MISMATCH');
  if (run.status !== 'assigned') throw new DispatchError('RUN_CONFLICT');
  if (run.currentOfferId !== offerId) throw new DispatchError('RUN_OFFER_MISMATCH');
  if (run.finalizedAt !== null) throw new DispatchError('RUN_FINALIZED');

  if (!positive(run.policyVersion) || !exactKeys(run.policySnapshot, POLICY_KEYS) ||
      !validatePolicy(run.policySnapshot) || !Array.isArray(run.candidates) ||
      run.candidates.length > run.policySnapshot.maxUniqueCandidatesPerGeneration ||
      run.candidates.length > 30 ||
      !Array.isArray(run.attemptedDriverIds) || !Array.isArray(run.excludedDriverIds) ||
      run.attemptedDriverIds.length > 30 || run.excludedDriverIds.length > 30 ||
      !isAuthoritativeTimestamp(run.createdAt, TimestampClass) ||
      !isAuthoritativeTimestamp(run.updatedAt, TimestampClass)) {
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
  if (!Number.isSafeInteger(run.nextCandidateIndex) || run.nextCandidateIndex !== k + 1) {
    throw new DispatchError('RUN_CURSOR_INVALID');
  }

  const ids = new Set();
  const rounds = new Map();
  const expectedAttempted = [];
  let lastRound = -1;
  let acceptedCount = 0;

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
    rounds.set(c.roundIndex, (rounds.get(c.roundIndex) || 0) + 1);
    if (rounds.get(c.roundIndex) > run.policySnapshot.maxMatrixShortlistPerRound) {
      throw new DispatchError('RUN_INVALID');
    }

    if (c.rankingMode === 'ola') {
      if (!finiteNonnegative(c.matrixEtaSeconds) || !finiteNonnegative(c.matrixDistanceMeters)) {
        throw new DispatchError('RUN_INVALID');
      }
    } else if (c.rankingMode !== 'haversine_degraded' || c.matrixEtaSeconds !== null || c.matrixDistanceMeters !== null) {
      throw new DispatchError('RUN_INVALID');
    }

    if (c.outcome === 'accepted') {
      acceptedCount++;
    }

    if (i < k) {
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
      if (c.driverId !== driverUid) {
        throw new DispatchError('CANDIDATE_MISMATCH');
      }
      if (c.outcome !== 'accepted') {
        throw new DispatchError('CANDIDATE_MISMATCH');
      }
      if (c.reasonCode !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      if (run.excludedDriverIds.includes(c.driverId)) {
        throw new DispatchError('RUN_INVALID');
      }
      expectedAttempted.push(c.driverId);
    } else {
      if (c.outcome !== 'pending' || c.reasonCode !== null) {
        throw new DispatchError('RUN_INVALID');
      }
      if (run.attemptedDriverIds.includes(c.driverId)) {
        throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
      }
      if (run.excludedDriverIds.includes(c.driverId)) {
        throw new DispatchError('RUN_INVALID');
      }
    }
  }

  if (acceptedCount !== 1) {
    throw new DispatchError('RUN_INVALID');
  }

  if (run.attemptedDriverIds.length !== expectedAttempted.length) {
    throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
  }
  for (let idx = 0; idx < expectedAttempted.length; idx++) {
    if (run.attemptedDriverIds[idx] !== expectedAttempted[idx]) {
      throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
    }
  }
  const currentAcceptedCount = run.attemptedDriverIds.filter(id => id === driverUid).length;
  if (currentAcceptedCount !== 1) {
    throw new DispatchError('RUN_ATTEMPTED_DRIVERS_MISMATCH');
  }

  if (run.excludedDriverIds.some(id => !ids.has(id) || !run.attemptedDriverIds.includes(id))) {
    throw new DispatchError('RUN_INVALID');
  }
  if (run.excludedDriverIds.includes(driverUid)) {
    throw new DispatchError('RUN_INVALID');
  }
  for (const c of run.candidates) {
    if (c.outcome === 'driver_cancelled' && !run.excludedDriverIds.includes(c.driverId)) {
      throw new DispatchError('RUN_INVALID');
    }
  }

  return true;
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

function compareTimestamps(a, b, TimestampClass) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (a instanceof Date || b instanceof Date) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (TimestampClass) {
    if (!(a instanceof TimestampClass) || !(b instanceof TimestampClass)) {
      throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    }
  } else {
    if (!isAuthoritativeTimestamp(a) || !isAuthoritativeTimestamp(b)) {
      throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    }
  }
  if (!Number.isInteger(a.seconds) || !Number.isInteger(a.nanoseconds) ||
      a.nanoseconds < 0 || a.nanoseconds >= 1e9 ||
      !Number.isInteger(b.seconds) || !Number.isInteger(b.nanoseconds) ||
      b.nanoseconds < 0 || b.nanoseconds >= 1e9) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (a.seconds !== b.seconds) {
    return a.seconds < b.seconds ? -1 : 1;
  }
  if (a.nanoseconds !== b.nanoseconds) {
    return a.nanoseconds < b.nanoseconds ? -1 : 1;
  }
  return 0;
}

function timestampsEqual(a, b, TimestampClass) {
  return compareTimestamps(a, b, TimestampClass) === 0;
}

function timestampLessThanOrEqual(a, b, TimestampClass) {
  return compareTimestamps(a, b, TimestampClass) <= 0;
}

function timestampLessThan(a, b, TimestampClass) {
  return compareTimestamps(a, b, TimestampClass) < 0;
}

function validateRequestIdAttribution(offer, debit) {
  if (offer.acceptRequestId === null) {
    if (debit.sourceRequestId !== null) {
      throw new DispatchError('LEDGER_INVALID');
    }
  } else if (typeof offer.acceptRequestId === 'string' && offer.acceptRequestId.length > 0 && !offer.acceptRequestId.includes('/')) {
    if (debit.sourceRequestId !== offer.acceptRequestId) {
      throw new DispatchError('LEDGER_INVALID');
    }
  } else {
    throw new DispatchError('LEDGER_INVALID');
  }
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

function validateCanonicalDeclineReceipt({
  receipt,
  jobId,
  offerId,
  driverUid,
  requestId,
  TimestampClass,
}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedKeys = [
    'actorUid',
    'claimedAt',
    'leaseUntil',
    'operation',
    'ownerToken',
    'payloadHash',
    'processedAt',
    'requestId',
    'resourceId',
    'result',
    'status',
    'type',
  ];
  if (!exactKeys(receipt, expectedKeys)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.requestId !== requestId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.status !== 'completed') {
    if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.type !== 'phase4_client_mutation') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.ownerToken !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.claimedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.leaseUntil !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.processedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.actorUid !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.operation !== 'decline') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.resourceId !== jobId + ':' + offerId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  if (receipt.payloadHash !== expectedPayloadHash) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!receipt.result || typeof receipt.result !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedResultKeys = ['declined', 'driverId', 'jobId', 'offerId'];
  if (!exactKeys(receipt.result, expectedResultKeys)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.result.declined !== true ||
      receipt.result.jobId !== jobId ||
      receipt.result.offerId !== offerId ||
      receipt.result.driverId !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  return true;
}

const OUTBOX_ALLOWED_STATES = Object.freeze(['pending', 'in_progress', 'retry_wait', 'sent', 'failed_terminal']);
const OUTBOX_ALLOWED_ERROR_CODES = Object.freeze([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_rejected_message',
  'provider_unknown_error',
  'recipient_unreachable',
  'configuration_missing',
  'internal_error',
]);
const OUTBOX_EXACT_KEYS = Object.freeze([
  'attemptCount', 'channel', 'createdAt', 'eventId', 'eventType', 'lastErrorCode',
  'leaseUntil', 'nextAttemptAt', 'ownerToken', 'payload', 'payloadVersion',
  'providerMessageId', 'recipientKey', 'resourceId', 'resourceType', 'sentAt',
  'state', 'updatedAt',
]);

function validateCanonicalOutboxRecord({
  outbox,
  expectedEventId,
  expectedEventType,
  expectedResourceType = 'job',
  expectedResourceId,
  expectedJobStatus,
  TimestampClass,
}) {
  if (!outbox || typeof outbox !== 'object' || Array.isArray(outbox)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!exactKeys(outbox, OUTBOX_EXACT_KEYS)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.eventId !== expectedEventId || outbox.eventType !== expectedEventType) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.resourceType !== expectedResourceType || outbox.resourceId !== expectedResourceId) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.channel !== 'whatsapp') {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.recipientKey !== 'customer:' + expectedResourceId) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.payloadVersion !== 1) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!outbox.payload || typeof outbox.payload !== 'object' || Array.isArray(outbox.payload)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!exactKeys(outbox.payload, ['jobId', 'jobStatus', 'refundAmountPaise'])) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.payload.jobId !== expectedResourceId ||
      outbox.payload.jobStatus !== expectedJobStatus ||
      outbox.payload.refundAmountPaise !== null) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!OUTBOX_ALLOWED_STATES.includes(outbox.state)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!Number.isSafeInteger(outbox.attemptCount) || outbox.attemptCount < 0) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (!isAuthoritativeTimestamp(outbox.createdAt, TimestampClass) ||
      !isAuthoritativeTimestamp(outbox.updatedAt, TimestampClass)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.lastErrorCode !== null && !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)) {
    throw new DispatchError('OUTBOX_INVALID');
  }
  if (outbox.providerMessageId !== null && (typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0)) {
    throw new DispatchError('OUTBOX_INVALID');
  }

  // State-specific invariants strictly matching notification_outbox_schema.json
  if (outbox.state === 'pending') {
    if (outbox.attemptCount !== 0 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
        outbox.providerMessageId !== null ||
        outbox.lastErrorCode !== null ||
        outbox.sentAt !== null) {
      throw new DispatchError('OUTBOX_INVALID');
    }
  } else if (outbox.state === 'in_progress') {
    if (outbox.attemptCount < 1 ||
        typeof outbox.ownerToken !== 'string' || outbox.ownerToken.length === 0 ||
        !isAuthoritativeTimestamp(outbox.leaseUntil, TimestampClass) ||
        outbox.providerMessageId !== null ||
        outbox.sentAt !== null) {
      throw new DispatchError('OUTBOX_INVALID');
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      throw new DispatchError('OUTBOX_INVALID');
    }
    if (outbox.lastErrorCode !== null && !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)) {
      throw new DispatchError('OUTBOX_INVALID');
    }
  } else if (outbox.state === 'retry_wait') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
        !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode) ||
        outbox.providerMessageId !== null ||
        outbox.sentAt !== null) {
      throw new DispatchError('OUTBOX_INVALID');
    }
  } else if (outbox.state === 'sent') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.sentAt, TimestampClass) ||
        typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0 ||
        outbox.lastErrorCode !== null) {
      throw new DispatchError('OUTBOX_INVALID');
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      throw new DispatchError('OUTBOX_INVALID');
    }
  } else if (outbox.state === 'failed_terminal') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode) ||
        outbox.sentAt !== null) {
      throw new DispatchError('OUTBOX_INVALID');
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      throw new DispatchError('OUTBOX_INVALID');
    }
    if (outbox.providerMessageId !== null && (typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0)) {
      throw new DispatchError('OUTBOX_INVALID');
    }
  }

  return true;
}

const PHASE4_RECEIPT_EXACT_KEYS = Object.freeze([
  'actorUid', 'claimedAt', 'leaseUntil', 'operation', 'ownerToken',
  'payloadHash', 'processedAt', 'requestId', 'resourceId', 'result',
  'status', 'type',
]);

function validateCanonicalStartReceipt({
  receipt,
  jobId,
  offerId,
  driverUid,
  requestId,
  TimestampClass,
}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!exactKeys(receipt, PHASE4_RECEIPT_EXACT_KEYS)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.requestId !== requestId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.status !== 'completed') {
    if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.type !== 'phase4_client_mutation') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.ownerToken !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.claimedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.leaseUntil !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.processedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.actorUid !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.operation !== 'start_job') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.resourceId !== jobId + ':' + offerId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  if (receipt.payloadHash !== expectedPayloadHash) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!receipt.result || typeof receipt.result !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!exactKeys(receipt.result, ['driverId', 'jobId', 'offerId', 'started'])) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.result.started !== true ||
      receipt.result.jobId !== jobId ||
      receipt.result.offerId !== offerId ||
      receipt.result.driverId !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  return true;
}

function validateCanonicalCompleteReceipt({
  receipt,
  jobId,
  offerId,
  driverUid,
  requestId,
  TimestampClass,
}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!exactKeys(receipt, PHASE4_RECEIPT_EXACT_KEYS)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.requestId !== requestId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.status !== 'completed') {
    if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.type !== 'phase4_client_mutation') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.ownerToken !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.claimedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.leaseUntil !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.processedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.actorUid !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.operation !== 'complete_job') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.resourceId !== jobId + ':' + offerId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  if (receipt.payloadHash !== expectedPayloadHash) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!receipt.result || typeof receipt.result !== 'object') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!exactKeys(receipt.result, ['completed', 'driverId', 'jobId', 'offerId'])) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.result.completed !== true ||
      receipt.result.jobId !== jobId ||
      receipt.result.offerId !== offerId ||
      receipt.result.driverId !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  return true;
}

function validateCanonicalStartingAcceptedOccurrence({
  job,
  offer,
  run,
  driver,
  ledger,
  acceptedOutbox,
  historicalReceipt,
  jobId,
  offerId,
  driverUid,
  nowMs,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'accepted') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.dispatchState !== 'assigned') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (job.inProgressAt != null || job.completedAt != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }

  // Customer cancellation provenance / precedence
  validateAcceptanceCancellationProvenance(job, offer);

  // Clean terminal/refund fields
  if (job.cancelledAt != null || job.cancelledBy != null || job.cancellationReason != null ||
      job.cancellationResolvedAt != null || (job.cancellationResolutionState != null && job.cancellationResolutionState !== 'none')) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (offer.status !== 'accepted') throw new DispatchError('OFFER_NOT_ACCEPTED');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (offer.inProgressAt != null || offer.completedAt != null) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.resolvedAt != null || offer.resolutionReason != null) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (offer.driverCommissionPaise !== job.driverCommissionPaise) throw new DispatchError('ACCEPTANCE_CONFLICT');
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  // Timestamps coherence & ordering
  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  const boundaryTimestamp = TimestampClass.fromMillis(nowMs);
  if (!timestampLessThanOrEqual(job.acceptedAt, boundaryTimestamp, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 3. RUN
  validateCanonicalAssignedRun({
    run,
    job,
    offer,
    jobId,
    offerId,
    driverUid,
    TimestampClass,
  });

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeOfferId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');

  // 5. LEDGER
  if (!ledger || typeof ledger !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (ledger.operationId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.driverId !== driverUid || ledger.jobId !== jobId || ledger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (ledger.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.forfeiturePaise !== 0 || ledger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceBeforePaise) || ledger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceAfterPaise) || ledger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.balanceBeforePaise - job.driverCommissionPaise !== ledger.balanceAfterPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (ledger.sourceType !== 'driver' || ledger.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(ledger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  if (offer.acceptRequestId !== ledger.sourceRequestId) throw new DispatchError('LEDGER_INVALID');

  // 6. ACCEPTED OUTBOX
  validateCanonicalOutboxRecord({
    outbox: acceptedOutbox,
    expectedEventId: 'job_accepted:' + jobId + ':' + offerId,
    expectedEventType: 'job_accepted',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'accepted',
    TimestampClass,
  });

  // 7. HISTORICAL ACCEPT RECEIPT (if present on offer)
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

  return true;
}

function validateCanonicalInProgressOccurrence({
  job,
  offer,
  run,
  driver,
  ledger,
  acceptedOutbox,
  inProgressOutbox,
  historicalReceipt,
  jobId,
  offerId,
  driverUid,
  nowMs,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'in_progress') throw new DispatchError('JOB_NOT_IN_PROGRESS');
  if (job.dispatchState !== 'assigned') throw new DispatchError('JOB_NOT_IN_PROGRESS');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!isAuthoritativeTimestamp(job.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (job.completedAt != null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }

  // Customer cancellation provenance / precedence
  validateAcceptanceCancellationProvenance(job, offer);

  // Clean terminal/refund fields
  if (job.cancelledAt != null || job.cancelledBy != null || job.cancellationReason != null ||
      job.cancellationResolvedAt != null || (job.cancellationResolutionState != null && job.cancellationResolutionState !== 'none')) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (offer.status !== 'in_progress') throw new DispatchError('OFFER_NOT_IN_PROGRESS');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('IN_PROGRESS_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.inProgressAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (offer.completedAt != null) throw new DispatchError('IN_PROGRESS_CONFLICT');
  if (offer.resolvedAt != null || offer.resolutionReason != null) throw new DispatchError('IN_PROGRESS_CONFLICT');
  if (offer.driverCommissionPaise !== job.driverCommissionPaise) throw new DispatchError('IN_PROGRESS_CONFLICT');
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  // Timestamps coherence & ordering
  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampsEqual(job.inProgressAt, offer.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(job.acceptedAt, job.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  const boundaryTimestamp = TimestampClass.fromMillis(nowMs);
  if (!timestampLessThanOrEqual(job.inProgressAt, boundaryTimestamp, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 3. RUN
  validateCanonicalAssignedRun({
    run,
    job,
    offer,
    jobId,
    offerId,
    driverUid,
    TimestampClass,
  });

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeOfferId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('IN_PROGRESS_CONFLICT');

  // 5. LEDGER
  if (!ledger || typeof ledger !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (ledger.operationId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.driverId !== driverUid || ledger.jobId !== jobId || ledger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (ledger.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.forfeiturePaise !== 0 || ledger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceBeforePaise) || ledger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceAfterPaise) || ledger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.balanceBeforePaise - job.driverCommissionPaise !== ledger.balanceAfterPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (ledger.sourceType !== 'driver' || ledger.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(ledger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  if (offer.acceptRequestId !== ledger.sourceRequestId) throw new DispatchError('LEDGER_INVALID');

  // 6. ACCEPTED OUTBOX
  validateCanonicalOutboxRecord({
    outbox: acceptedOutbox,
    expectedEventId: 'job_accepted:' + jobId + ':' + offerId,
    expectedEventType: 'job_accepted',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'accepted',
    TimestampClass,
  });

  // 7. IN_PROGRESS OUTBOX
  validateCanonicalOutboxRecord({
    outbox: inProgressOutbox,
    expectedEventId: 'job_in_progress:' + jobId,
    expectedEventType: 'job_in_progress',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'in_progress',
    TimestampClass,
  });

  // 8. HISTORICAL ACCEPT RECEIPT (if present on offer)
  if (offer.acceptRequestId !== null) {
    if (!historicalReceipt || typeof historicalReceipt !== 'object') {
      throw new DispatchError('IN_PROGRESS_CONFLICT');
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

  return true;
}

const OFFER_EXACT_KEYS = Object.freeze([
  'jobId', 'driverId', 'dispatchGeneration', 'candidateIndex', 'roundIndex',
  'status', 'offeredAt', 'expiresAt', 'resolvedAt', 'resolutionReason',
  'acceptedAt', 'inProgressAt', 'completedAt', 'timeoutTaskId',
  'timeoutTaskState', 'acceptRequestId', 'cancellationPolicySnapshot',
  'pickupCoords', 'destCoords', 'requestedTruckType',
  'pickupRoutedDistanceMeters', 'pickupEtaSeconds', 'estimatedFarePaise',
  'driverCommissionPaise', 'createdAt', 'updatedAt',
]);

const WALLET_EXACT_KEYS = Object.freeze([
  'operationId', 'driverId', 'jobId', 'offerId', 'type', 'commissionPaise',
  'forfeiturePaise', 'creditPaise', 'deltaPaise', 'balanceBeforePaise',
  'balanceAfterPaise', 'cancellationPolicyEvidence', 'sourceRequestId',
  'sourceType', 'actorUid', 'createdAt',
]);

function validateCanonicalCustomerCancelledOfferedOccurrence({
  job,
  offer,
  run,
  driver,
  jobId,
  offerId,
  driverUid,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'offered') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.dispatchState !== 'offered') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.assignedDriver !== null) throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.offeredTo !== driverUid) throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (!isAuthoritativeTimestamp(job.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(job.offerExpiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Object.hasOwn(job, 'completedAt') || job.completedAt !== null ||
      !Object.hasOwn(job, 'acceptedAt') || job.acceptedAt !== null ||
      !Object.hasOwn(job, 'inProgressAt') || job.inProgressAt !== null) {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }
  if (job.commissionDebitEntryId !== null) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
    throw new DispatchError('COMMISSION_PAISE_INVALID');
  }

  // Provenance / cancellation marker
  if (job.cancelledBy !== 'customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationReason !== 'customer_requested') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationResolutionState !== 'pending') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (job.cancellationResolvedAt != null || job.cancelledAt != null) throw new DispatchError('CANCELLATION_CONFLICT');

  // Refund fields must be clean
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.status !== 'offered') throw new DispatchError('OFFER_NOT_OFFERED');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.offeredAt, offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.offerExpiresAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.offeredAt, job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Object.hasOwn(offer, 'completedAt') || offer.completedAt !== null ||
      !Object.hasOwn(offer, 'acceptedAt') || offer.acceptedAt !== null ||
      !Object.hasOwn(offer, 'inProgressAt') || offer.inProgressAt !== null ||
      offer.resolvedAt !== null || offer.resolutionReason !== null) {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }
  if (!Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('COMMISSION_MISMATCH');
  }
  if (offer.cancellationPolicySnapshot !== null) throw new DispatchError('CANCELLATION_CONFLICT');

  // 3. RUN
  if (!run || typeof run !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (run.status !== 'active') throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.jobId !== jobId) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.generation !== job.dispatchGeneration) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.currentOfferId !== offerId) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.finalizedAt != null) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!nonnegative(run.nextCandidateIndex)) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('CANCELLATION_CONFLICT');
  const candidate = run.candidates[offer.candidateIndex];
  if (!candidate || candidate.driverId !== driverUid || candidate.outcome !== 'offered') {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeOfferId !== offerId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('CANCELLATION_CONFLICT');

  return true;
}

function validateCanonicalCustomerCancelledAcceptedOccurrence({
  job,
  offer,
  run,
  driver,
  ledger,
  acceptedOutbox,
  historicalReceipt,
  jobId,
  offerId,
  driverUid,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'accepted') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.dispatchState !== 'assigned') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!Object.hasOwn(job, 'completedAt') || job.completedAt !== null ||
      !Object.hasOwn(job, 'inProgressAt') || job.inProgressAt !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
    throw new DispatchError('LEDGER_INVALID');
  }

  // Provenance / cancellation marker
  if (job.cancelledBy !== 'customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationReason !== 'customer_requested') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationResolutionState !== 'pending') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (job.cancellationResolvedAt != null || job.cancelledAt != null) throw new DispatchError('CANCELLATION_CONFLICT');

  // Clean refund fields
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.status !== 'accepted') throw new DispatchError('OFFER_NOT_ACCEPTED');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Object.hasOwn(offer, 'completedAt') || offer.completedAt !== null ||
      !Object.hasOwn(offer, 'inProgressAt') || offer.inProgressAt !== null ||
      offer.resolvedAt !== null || offer.resolutionReason !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.offeredAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.acceptedAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.acceptedAt, job.cancellationRequestedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 3. RUN
  validateCanonicalAssignedRun({
    run,
    job,
    offer,
    jobId,
    offerId,
    driverUid,
    TimestampClass,
  });
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('CANCELLATION_CONFLICT');
  const runCandidate = run.candidates[offer.candidateIndex];
  if (!runCandidate || runCandidate.driverId !== driverUid || runCandidate.outcome !== 'accepted') {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeOfferId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');

  // 5. LEDGER
  if (!ledger || typeof ledger !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (!exactKeys(ledger, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
  if (ledger.operationId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.driverId !== driverUid || ledger.jobId !== jobId || ledger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.commissionPaise) || ledger.commissionPaise <= 0 || ledger.commissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (ledger.forfeiturePaise !== 0 || ledger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.deltaPaise) || ledger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceBeforePaise) || ledger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceAfterPaise) || ledger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.balanceBeforePaise - job.driverCommissionPaise !== ledger.balanceAfterPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (ledger.sourceType !== 'driver' || ledger.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(ledger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  if (!timestampsEqual(ledger.createdAt, job.acceptedAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  validateRequestIdAttribution(offer, ledger);

  // 6. ACCEPTED OUTBOX
  validateCanonicalOutboxRecord({
    outbox: acceptedOutbox,
    expectedEventId: 'job_accepted:' + jobId + ':' + offerId,
    expectedEventType: 'job_accepted',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'accepted',
    TimestampClass,
  });

  // 7. HISTORICAL ACCEPT RECEIPT (if present on offer)
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

  return true;
}

function validateCanonicalCustomerCancelledInProgressOccurrence({
  job,
  offer,
  run,
  driver,
  ledger,
  acceptedOutbox,
  inProgressOutbox,
  historicalReceipt,
  jobId,
  offerId,
  driverUid,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'in_progress') throw new DispatchError('JOB_NOT_IN_PROGRESS');
  if (job.dispatchState !== 'assigned') throw new DispatchError('JOB_NOT_IN_PROGRESS');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!isAuthoritativeTimestamp(job.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!Object.hasOwn(job, 'completedAt') || job.completedAt !== null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
    throw new DispatchError('LEDGER_INVALID');
  }

  // Provenance / cancellation marker
  if (job.cancelledBy !== 'customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationReason !== 'customer_requested') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationResolutionState !== 'pending') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (job.cancellationResolvedAt != null || job.cancelledAt != null) throw new DispatchError('CANCELLATION_CONFLICT');

  // Clean refund fields
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.status !== 'in_progress') throw new DispatchError('OFFER_NOT_IN_PROGRESS');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('IN_PROGRESS_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.inProgressAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Object.hasOwn(offer, 'completedAt') || offer.completedAt !== null ||
      offer.resolvedAt !== null || offer.resolutionReason !== null) {
    throw new DispatchError('IN_PROGRESS_CONFLICT');
  }
  if (!Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampsEqual(job.inProgressAt, offer.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.offeredAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.acceptedAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(job.acceptedAt, job.inProgressAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(job.inProgressAt, job.cancellationRequestedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 3. RUN
  validateCanonicalAssignedRun({
    run,
    job,
    offer,
    jobId,
    offerId,
    driverUid,
    TimestampClass,
  });
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('CANCELLATION_CONFLICT');
  const inProgCandidate = run.candidates[offer.candidateIndex];
  if (!inProgCandidate || inProgCandidate.driverId !== driverUid || inProgCandidate.outcome !== 'accepted') {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }

  // 4. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeOfferId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('IN_PROGRESS_CONFLICT');

  // 5. LEDGER
  if (!ledger || typeof ledger !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (!exactKeys(ledger, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
  if (ledger.operationId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.driverId !== driverUid || ledger.jobId !== jobId || ledger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
  if (ledger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.commissionPaise) || ledger.commissionPaise <= 0 || ledger.commissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (ledger.forfeiturePaise !== 0 || ledger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.deltaPaise) || ledger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceBeforePaise) || ledger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(ledger.balanceAfterPaise) || ledger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
  if (ledger.balanceBeforePaise - job.driverCommissionPaise !== ledger.balanceAfterPaise) throw new DispatchError('LEDGER_INVALID');
  if (ledger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (ledger.sourceType !== 'driver' || ledger.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(ledger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  if (!timestampsEqual(ledger.createdAt, job.acceptedAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  validateRequestIdAttribution(offer, ledger);

  // 6. ACCEPTED OUTBOX
  validateCanonicalOutboxRecord({
    outbox: acceptedOutbox,
    expectedEventId: 'job_accepted:' + jobId + ':' + offerId,
    expectedEventType: 'job_accepted',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'accepted',
    TimestampClass,
  });

  // 7. IN_PROGRESS OUTBOX
  validateCanonicalOutboxRecord({
    outbox: inProgressOutbox,
    expectedEventId: 'job_in_progress:' + jobId,
    expectedEventType: 'job_in_progress',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'in_progress',
    TimestampClass,
  });

  // 8. HISTORICAL ACCEPT RECEIPT (if present on offer)
  if (offer.acceptRequestId !== null) {
    if (!historicalReceipt || typeof historicalReceipt !== 'object') {
      throw new DispatchError('IN_PROGRESS_CONFLICT');
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

  return true;
}

function validateCanonicalTerminalCustomerCancellationOccurrence({
  job,
  offer,
  run,
  driver,
  reversalLedger,
  cancelledOutbox,
  originalDebitLedger,
  jobId,
  offerId,
  driverUid,
  wasAssigned,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'cancelled_customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.dispatchState !== 'closed') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationResolutionState !== 'resolved') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(job.cancellationResolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(job.cancelledAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, job.cancelledAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (job.cancelledBy !== 'customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.cancellationReason !== 'customer_requested') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(job.cancellationRequestedAt, job.cancellationResolvedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!Object.hasOwn(job, 'completedAt') || job.completedAt !== null) throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 1 || job.stateVersion > Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.status !== 'cancelled_customer') throw new DispatchError('OFFER_NOT_CANCELLED');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!isAuthoritativeTimestamp(offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (offer.resolutionReason !== 'customer_cancelled') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!Object.hasOwn(offer, 'completedAt') || offer.completedAt !== null) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.offeredAt, job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.offeredAt, job.cancellationResolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');

  // 3. RUN
  if (!run || typeof run !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (run.status !== 'cancelled_customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.jobId !== jobId) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.generation !== job.dispatchGeneration) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.currentOfferId !== offerId) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(run.finalizedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, run.finalizedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('CANCELLATION_CONFLICT');
  const termCandidate = run.candidates[offer.candidateIndex];
  if (!termCandidate || termCandidate.driverId !== driverUid) throw new DispatchError('CANCELLATION_CONFLICT');

  // 4. OUTBOX
  validateCanonicalOutboxRecord({
    outbox: cancelledOutbox,
    expectedEventId: 'job_cancelled_customer:' + jobId,
    expectedEventType: 'job_cancelled_customer',
    expectedResourceType: 'job',
    expectedResourceId: jobId,
    expectedJobStatus: 'cancelled_customer',
    TimestampClass,
  });
  if (!timestampsEqual(job.cancellationResolvedAt, cancelledOutbox.createdAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 5. DRIVER
  if (!driver || typeof driver !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (driver.activeJobId === jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeOfferId === offerId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) throw new DispatchError('CANCELLATION_CONFLICT');

  // 6. LEDGER / ASSIGNMENT / CHRONOLOGY
  if (wasAssigned) {
    if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
    const expectedDebitLedgerId = 'commission_debit:' + jobId + ':' + offerId;
    if (job.commissionDebitEntryId !== expectedDebitLedgerId) throw new DispatchError('LEDGER_INVALID');

    if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');

    if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!timestampLessThanOrEqual(offer.offeredAt, offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!timestampLessThan(offer.acceptedAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!timestampLessThanOrEqual(offer.acceptedAt, job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    if (!timestampLessThanOrEqual(offer.acceptedAt, offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');

    if (job.inProgressAt != null || offer.inProgressAt != null) {
      if ((job.inProgressAt === null) !== (offer.inProgressAt === null)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      if (!isAuthoritativeTimestamp(job.inProgressAt, TimestampClass) || !isAuthoritativeTimestamp(offer.inProgressAt, TimestampClass)) {
        throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      }
      if (!timestampsEqual(job.inProgressAt, offer.inProgressAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      if (!timestampLessThanOrEqual(offer.acceptedAt, offer.inProgressAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      if (!timestampLessThanOrEqual(offer.inProgressAt, job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
      if (!timestampLessThanOrEqual(offer.inProgressAt, offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    }

    if (termCandidate.outcome !== 'accepted') throw new DispatchError('CANCELLATION_CONFLICT');

    if (!originalDebitLedger || typeof originalDebitLedger !== 'object') throw new DispatchError('LEDGER_INVALID');
    if (!exactKeys(originalDebitLedger, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.operationId !== expectedDebitLedgerId) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.driverId !== driverUid || originalDebitLedger.jobId !== jobId || originalDebitLedger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(originalDebitLedger.commissionPaise) || originalDebitLedger.commissionPaise <= 0) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.forfeiturePaise !== 0 || originalDebitLedger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(originalDebitLedger.balanceBeforePaise) || originalDebitLedger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(originalDebitLedger.balanceAfterPaise) || originalDebitLedger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.balanceBeforePaise - job.driverCommissionPaise !== originalDebitLedger.balanceAfterPaise) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
    if (originalDebitLedger.sourceType !== 'driver' || originalDebitLedger.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
    if (!isAuthoritativeTimestamp(originalDebitLedger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
    if (!timestampsEqual(originalDebitLedger.createdAt, job.acceptedAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
    validateRequestIdAttribution(offer, originalDebitLedger);

    const expectedCreditLedgerId = 'customer_cancel_credit:' + jobId + ':' + offerId;
    if (!reversalLedger || typeof reversalLedger !== 'object') throw new DispatchError('LEDGER_INVALID');
    if (!exactKeys(reversalLedger, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.operationId !== expectedCreditLedgerId) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.driverId !== driverUid || reversalLedger.jobId !== jobId || reversalLedger.offerId !== offerId) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.type !== 'customer_cancel_credit') throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.commissionPaise !== originalDebitLedger.commissionPaise) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.forfeiturePaise !== 0) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.creditPaise !== originalDebitLedger.commissionPaise) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.deltaPaise !== originalDebitLedger.commissionPaise) throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(reversalLedger.balanceBeforePaise) || reversalLedger.balanceBeforePaise < 0) throw new DispatchError('LEDGER_INVALID');
    if (!Number.isSafeInteger(reversalLedger.balanceAfterPaise) || reversalLedger.balanceAfterPaise < 0) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.balanceAfterPaise !== reversalLedger.balanceBeforePaise + reversalLedger.deltaPaise) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.deltaPaise !== -originalDebitLedger.deltaPaise) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.sourceType !== 'customer') throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.actorUid !== null) throw new DispatchError('LEDGER_INVALID');
    if (reversalLedger.sourceRequestId !== null) throw new DispatchError('LEDGER_INVALID');
    if (!isAuthoritativeTimestamp(reversalLedger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
    if (!timestampsEqual(job.cancellationResolvedAt, reversalLedger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  } else {
    if (job.assignedDriver !== null) throw new DispatchError('CANCELLATION_CONFLICT');
    if (job.commissionDebitEntryId !== null) throw new DispatchError('LEDGER_INVALID');
    if (!Object.hasOwn(job, 'acceptedAt') || job.acceptedAt !== null ||
        !Object.hasOwn(job, 'inProgressAt') || job.inProgressAt !== null) {
      throw new DispatchError('CANCELLATION_CONFLICT');
    }
    if (!Object.hasOwn(offer, 'acceptedAt') || offer.acceptedAt !== null ||
        !Object.hasOwn(offer, 'inProgressAt') || offer.inProgressAt !== null) {
      throw new DispatchError('CANCELLATION_CONFLICT');
    }
    if (termCandidate.outcome !== 'offered') throw new DispatchError('CANCELLATION_CONFLICT');
    if (reversalLedger != null || originalDebitLedger != null) throw new DispatchError('LEDGER_INVALID');
  }

  return true;
}

const CANCELLATION_EVIDENCE_EXACT_KEYS = Object.freeze([
  'banDurationDays',
  'banThresholdCount',
  'cancellationCount',
  'cancellationMonth',
  'capturedAt',
  'forfeitPctByCount',
  'forfeiturePercent',
  'freeCancellationsPerMonth',
  'roundingMode',
  'strictModeApplied',
  'strictModeBefore',
  'timezone',
  'version',
]);

function getIstMonthString(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    throw new DispatchError('INVALID_ARGUMENT');
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(d);
}

function classifyCustomerCancellationProvenance(job, TimestampClass) {
  if (!job || typeof job !== 'object') {
    throw new DispatchError('DOCUMENT_NOT_FOUND');
  }

  const {
    cancelledBy,
    cancellationReason,
    cancellationResolutionState,
    cancellationRequestedAt,
    cancellationResolvedAt,
    cancelledAt,
  } = job;

  // A. NO CUSTOMER CANCELLATION
  const isNone = (
    cancellationResolutionState === 'none' &&
    cancelledBy === null &&
    cancellationReason === null &&
    cancellationRequestedAt === null &&
    cancellationResolvedAt === null &&
    cancelledAt === null
  );
  if (isNone) {
    return 'NONE';
  }

  // B. CANONICAL CUSTOMER CANCELLATION PENDING
  const isPending = (
    cancelledBy === 'customer' &&
    cancellationReason === 'customer_requested' &&
    cancellationResolutionState === 'pending' &&
    isAuthoritativeTimestamp(cancellationRequestedAt, TimestampClass) &&
    cancellationResolvedAt === null &&
    cancelledAt === null
  );
  if (isPending) {
    return 'PENDING';
  }

  // C. CANONICAL CUSTOMER TERMINAL
  const isTerminal = (
    job.status === 'cancelled_customer' &&
    job.dispatchState === 'closed' &&
    cancelledBy === 'customer' &&
    cancellationReason === 'customer_requested' &&
    cancellationResolutionState === 'resolved' &&
    isAuthoritativeTimestamp(cancellationRequestedAt, TimestampClass) &&
    isAuthoritativeTimestamp(cancellationResolvedAt, TimestampClass) &&
    isAuthoritativeTimestamp(cancelledAt, TimestampClass) &&
    timestampLessThanOrEqual(cancellationRequestedAt, cancellationResolvedAt, TimestampClass) &&
    timestampsEqual(cancellationResolvedAt, cancelledAt, TimestampClass)
  );
  if (isTerminal) {
    return 'TERMINAL';
  }

  // D. CONTRADICTORY / PARTIAL PROVENANCE -> FAIL CLOSED
  throw new DispatchError('ACCEPTANCE_CONFLICT');
}

function validateCanonicalDriverForCancellation(driver, TimestampClass, currentMonth = null) {
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    throw new DispatchError('DOCUMENT_NOT_FOUND');
  }
  // Wallet balance
  if (!Number.isSafeInteger(driver.walletBalance) || driver.walletBalance < 0) {
    throw new DispatchError('WALLET_BALANCE_INVALID');
  }
  // Strict mode
  if (typeof driver.strictMode !== 'boolean') {
    throw new DispatchError('DRIVER_INVALID');
  }
  // Banned until
  if (driver.bannedUntil !== null) {
    if (!isAuthoritativeTimestamp(driver.bannedUntil, TimestampClass)) {
      throw new DispatchError('DRIVER_INVALID');
    }
  }
  // Capability / schema fields (structural type validity)
  if (typeof driver.canFlatbed !== 'boolean' || typeof driver.canPulling !== 'boolean') {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (typeof driver.isOnDuty !== 'boolean') {
    throw new DispatchError('DRIVER_INVALID');
  }
  const VALID_VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'];
  if (!VALID_VERIFICATION_STATUSES.includes(driver.verificationStatus)) {
    throw new DispatchError('DRIVER_INVALID');
  }
  const VALID_TRUCK_TYPES = ['flatbed', 'tochan', 'hydraulic', 'crane'];
  if (!VALID_TRUCK_TYPES.includes(driver.truckType)) {
    throw new DispatchError('DRIVER_INVALID');
  }
  // Monthly cancel count
  const mcc = driver.monthlyCancelCount;
  if (!mcc || typeof mcc !== 'object' || Array.isArray(mcc)) {
    throw new DispatchError('DRIVER_INVALID');
  }
  const mccKeys = ['count', 'month'];
  if (!exactKeys(mcc, mccKeys)) {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (typeof mcc.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mcc.month)) {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (!Number.isSafeInteger(mcc.count) || mcc.count < 0 || mcc.count > Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('DRIVER_INVALID');
  }
  if (currentMonth !== null && currentMonth !== undefined) {
    if (mcc.month === currentMonth && mcc.count >= Number.MAX_SAFE_INTEGER) {
      throw new DispatchError('DRIVER_INVALID');
    }
  }
  return true;
}

function calculateForfeitureHalfUp(commissionPaise, forfeiturePercent) {
  if (!Number.isSafeInteger(commissionPaise) || commissionPaise < 0) {
    throw new DispatchError('COMMISSION_PAISE_INVALID');
  }
  if (!Number.isSafeInteger(forfeiturePercent) || forfeiturePercent < 0 || forfeiturePercent > 100) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  const commBig = BigInt(commissionPaise);
  const pctBig = BigInt(forfeiturePercent);
  const forfeitBig = (commBig * pctBig + 50n) / 100n;
  if (forfeitBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DispatchError('CALCULATION_OVERFLOW');
  }
  const forfeiturePaise = Number(forfeitBig);
  const creditBig = commBig - forfeitBig;
  if (creditBig < 0n || creditBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DispatchError('CALCULATION_OVERFLOW');
  }
  const creditPaise = Number(creditBig);
  if (!Number.isSafeInteger(forfeiturePaise) || !Number.isSafeInteger(creditPaise) ||
      forfeiturePaise < 0 || creditPaise < 0 ||
      forfeiturePaise + creditPaise !== commissionPaise) {
    throw new DispatchError('CALCULATION_ERROR');
  }
  return { forfeiturePaise, creditPaise };
}

function evaluateDriverCancellation({ policy, driver, commissionPaise, eventDate, TimestampClass }) {
  if (!policy || typeof policy !== 'object') {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  if (!driver || typeof driver !== 'object') {
    throw new DispatchError('DOCUMENT_NOT_FOUND');
  }

  const eventMs = eventDate instanceof Date ? eventDate.getTime() : typeof eventDate === 'number' ? eventDate : Date.now();
  const currentMonth = getIstMonthString(eventMs);

  // Validate driver state strictly before ANY normalization (Blocker 2)
  validateCanonicalDriverForCancellation(driver, TimestampClass, currentMonth);

  if (!Number.isSafeInteger(commissionPaise) || commissionPaise <= 0) {
    throw new DispatchError('COMMISSION_PAISE_INVALID');
  }

  const F = Number.isSafeInteger(policy.free_cancellations_per_month)
    ? policy.free_cancellations_per_month
    : policy.freeCancellationsPerMonth;
  const B = Number.isSafeInteger(policy.ban_threshold_count)
    ? policy.ban_threshold_count
    : policy.banThresholdCount;
  const banDurationDays = Number.isSafeInteger(policy.ban_duration_days)
    ? policy.ban_duration_days
    : policy.banDurationDays;
  const ramp = policy.forfeit_pct_by_count || policy.forfeitPctByCount;
  const version = policy.version;
  const timezone = policy.timezone;
  const roundingMode = policy.roundingMode;

  if (!positive(version) || timezone !== 'Asia/Kolkata' || roundingMode !== 'HALF_UP' ||
      !nonnegative(F) || !positive(B) || B <= F + 1 || !positive(banDurationDays)) {
    throw new DispatchError('CANCELLATION_POLICY_INVALID');
  }
  validateCancellationRamp(ramp, F, B, 'CANCELLATION_POLICY_INVALID');

  const rawMonthly = driver.monthlyCancelCount;
  let countBefore = 0;
  let strictModeBefore = false;

  if (rawMonthly.month === currentMonth) {
    countBefore = rawMonthly.count;
    strictModeBefore = driver.strictMode === true;
  } else {
    // Valid old month resets to 0 and non-strict
    countBefore = 0;
    strictModeBefore = false;
  }

  const countAfter = countBefore + 1;
  if (!Number.isSafeInteger(countAfter) || countAfter > Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('DRIVER_INVALID');
  }

  let forfeitPct;
  let strictModeAfter;
  let shouldBan;

  if (strictModeBefore) {
    forfeitPct = 100;
    strictModeAfter = true;
    shouldBan = true;
  } else if (countAfter <= F) {
    forfeitPct = 0;
    strictModeAfter = false;
    shouldBan = false;
  } else if (countAfter < B) {
    const rampKey = String(countAfter);
    if (!ramp || !Object.prototype.hasOwnProperty.call(ramp, rampKey)) {
      throw new DispatchError('CANCELLATION_POLICY_INVALID');
    }
    forfeitPct = ramp[rampKey];
    strictModeAfter = false;
    shouldBan = false;
  } else {
    forfeitPct = 100;
    strictModeAfter = true;
    shouldBan = true;
  }

  // Blocker 3: Exact Half-Up integer paise arithmetic
  const { forfeiturePaise, creditPaise } = calculateForfeitureHalfUp(commissionPaise, forfeitPct);

  let bannedUntil = null;
  const existingBanMs = (driver.bannedUntil && isAuthoritativeTimestamp(driver.bannedUntil, TimestampClass))
    ? timestampMillis(driver.bannedUntil)
    : 0;

  if (shouldBan) {
    const banDurationMs = banDurationDays * 24 * 60 * 60 * 1000;
    bannedUntil = TimestampClass.fromMillis(eventMs + banDurationMs);
  } else {
    if (existingBanMs > eventMs) {
      bannedUntil = driver.bannedUntil;
    }
  }

  const evidenceCapturedAt = policy.capturedAt && isAuthoritativeTimestamp(policy.capturedAt, TimestampClass)
    ? policy.capturedAt
    : TimestampClass.fromMillis(eventMs);

  const evidence = {
    version,
    timezone,
    roundingMode,
    freeCancellationsPerMonth: F,
    forfeitPctByCount: { ...ramp },
    banThresholdCount: B,
    banDurationDays,
    cancellationMonth: currentMonth,
    cancellationCount: countAfter,
    strictModeBefore,
    strictModeApplied: strictModeBefore || countAfter >= B,
    forfeiturePercent: forfeitPct,
    capturedAt: evidenceCapturedAt,
  };

  return {
    countBefore,
    countAfter,
    forfeitPct,
    forfeiturePaise,
    creditPaise,
    strictModeBefore,
    strictModeAfter,
    bannedUntil,
    currentMonth,
    evidence,
  };
}

function validateCanonicalDriverCancelReceipt({
  receipt,
  jobId,
  offerId,
  driverUid,
  requestId,
  TimestampClass,
}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!exactKeys(receipt, PHASE4_RECEIPT_EXACT_KEYS)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.requestId !== requestId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.status !== 'completed') {
    if (receipt.status === 'in_progress') throw new DispatchError('REQUEST_IN_PROGRESS');
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.type !== 'phase4_client_mutation') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.ownerToken !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.claimedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.leaseUntil !== null) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(receipt.processedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  // Blocker 7: claimedAt and processedAt equality, processedAt must never precede claimedAt
  if (!timestampsEqual(receipt.claimedAt, receipt.processedAt, TimestampClass)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.actorUid !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.operation !== 'driver_cancel') {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.resourceId !== jobId + ':' + offerId) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedPayloadHash = crypto.createHash('sha256').update(JSON.stringify({ jobId, offerId }), 'utf8').digest('hex');
  if (receipt.payloadHash !== expectedPayloadHash) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (!receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const expectedResultKeys = ['cancelled', 'driverId', 'forfeitedPaise', 'jobId', 'offerId', 'refundPaise'];
  if (!exactKeys(receipt.result, expectedResultKeys)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  if (receipt.result.cancelled !== true ||
      receipt.result.jobId !== jobId ||
      receipt.result.offerId !== offerId ||
      receipt.result.driverId !== driverUid) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  const { forfeitedPaise, refundPaise } = receipt.result;
  if (!Number.isSafeInteger(forfeitedPaise) || forfeitedPaise < 0 ||
      !Number.isSafeInteger(refundPaise) || refundPaise < 0) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  // Blocker 7: Total must be a positive safe integer (both cannot be zero, money sum safe)
  const totalBig = BigInt(forfeitedPaise) + BigInt(refundPaise);
  if (totalBig <= 0n || totalBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DispatchError('REQUEST_BINDING_CONFLICT');
  }
  return true;
}

function validateTerminalAcceptedCustomerCancellationProvenance({
  job,
  offer,
  run,
  originalDebitLedger,
  jobId,
  offerId,
  driverUid,
  TimestampClass,
}) {
  // 1. JOB
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'cancelled_customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.dispatchState !== 'closed') throw new DispatchError('CANCELLATION_CONFLICT');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  const expectedDebitLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedDebitLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(job.cancellationResolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(job.cancelledAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, job.cancelledAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (job.cancelledBy !== 'customer' || job.cancellationReason !== 'customer_requested') {
    throw new DispatchError('CANCELLATION_CONFLICT');
  }
  if (!timestampLessThanOrEqual(job.cancellationRequestedAt, job.cancellationResolvedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  // Chronology: customer cancellationRequestedAt must not precede acceptance
  if (!timestampLessThanOrEqual(job.acceptedAt, job.cancellationRequestedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }

  // 2. OFFER
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (offer.status !== 'cancelled_customer') throw new DispatchError('OFFER_NOT_CANCELLED');
  if (offer.resolutionReason !== 'customer_cancelled') throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass) || !isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.offeredAt, offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThan(offer.acceptedAt, offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.acceptedAt, job.cancellationRequestedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampLessThanOrEqual(offer.acceptedAt, offer.resolvedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Number.isSafeInteger(offer.driverCommissionPaise) || offer.driverCommissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }

  // 3. RUN
  if (!run || typeof run !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (run.jobId !== jobId || run.generation !== job.dispatchGeneration) throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.status !== 'cancelled_customer') throw new DispatchError('CANCELLATION_CONFLICT');
  if (run.currentOfferId !== offerId) throw new DispatchError('CANCELLATION_CONFLICT');
  if (!isAuthoritativeTimestamp(run.finalizedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!timestampsEqual(job.cancellationResolvedAt, run.finalizedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('CANCELLATION_CONFLICT');
  const termCandidate = run.candidates[offer.candidateIndex];
  if (!termCandidate || termCandidate.driverId !== driverUid) throw new DispatchError('CANCELLATION_CONFLICT');
  if (termCandidate.outcome !== 'accepted') throw new DispatchError('CANCELLATION_CONFLICT');
  if (termCandidate.roundIndex !== offer.roundIndex) throw new DispatchError('CANCELLATION_CONFLICT');

  // 4. DEBIT
  if (!originalDebitLedger || typeof originalDebitLedger !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (!exactKeys(originalDebitLedger, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
  if (originalDebitLedger.operationId !== expectedDebitLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (originalDebitLedger.driverId !== driverUid || originalDebitLedger.jobId !== jobId || originalDebitLedger.offerId !== offerId) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebitLedger.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(originalDebitLedger.commissionPaise) || originalDebitLedger.commissionPaise <= 0) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebitLedger.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (originalDebitLedger.forfeiturePaise !== 0 || originalDebitLedger.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (originalDebitLedger.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(originalDebitLedger.balanceBeforePaise) || originalDebitLedger.balanceBeforePaise < 0) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (!Number.isSafeInteger(originalDebitLedger.balanceAfterPaise) || originalDebitLedger.balanceAfterPaise < 0) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebitLedger.balanceBeforePaise - job.driverCommissionPaise !== originalDebitLedger.balanceAfterPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebitLedger.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (originalDebitLedger.sourceType !== 'driver' || originalDebitLedger.actorUid !== driverUid) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (!isAuthoritativeTimestamp(originalDebitLedger.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  if (!timestampsEqual(originalDebitLedger.createdAt, job.acceptedAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  validateRequestIdAttribution(offer, originalDebitLedger);

  return true;
}

function validateCanonicalAcceptedDriverCancellationOccurrence({
  job,
  offer,
  run,
  driver,
  originalDebit,
  creditExists,
  jobId,
  offerId,
  driverUid,
  TimestampClass,
  currentMonth = null,
  cancellationEventAt = null,
}) {
  // 1. JOB (Blocker 5)
  if (!job || typeof job !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (job.status !== 'accepted') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.dispatchState !== 'assigned') throw new DispatchError('JOB_NOT_ACCEPTED');
  if (job.assignedDriver !== driverUid) throw new DispatchError('WRONG_DRIVER');
  if (job.currentOfferId !== offerId) throw new DispatchError('JOB_OFFER_MISMATCH');
  if (job.offeredTo !== null || job.offeredAt !== null || job.offerExpiresAt !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  // Stale dispatch lease / failure / next action state must be cleared in accepted state
  if (job.dispatchLeaseOwner != null || job.dispatchLeaseUntil != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (job.dispatchNextActionAt != null || job.dispatchLastFailure != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!isAuthoritativeTimestamp(job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!Object.hasOwn(job, 'completedAt') || job.completedAt !== null ||
      !Object.hasOwn(job, 'inProgressAt') || job.inProgressAt !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  const expectedLedgerId = 'commission_debit:' + jobId + ':' + offerId;
  if (job.commissionDebitEntryId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (!positive(job.dispatchGeneration) || job.dispatchRunId !== String(job.dispatchGeneration)) {
    throw new DispatchError('JOB_RUN_MISMATCH');
  }
  if (!Number.isSafeInteger(job.stateVersion) || job.stateVersion < 0 || job.stateVersion >= Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('JOB_STATE_VERSION_INVALID');
  }
  if (!Number.isSafeInteger(job.driverCommissionPaise) || job.driverCommissionPaise <= 0) {
    throw new DispatchError('COMMISSION_PAISE_INVALID');
  }
  // Forfeited amount must be null/absent or a non-negative safe integer
  if (job.forfeitedAmount != null && (!Number.isSafeInteger(job.forfeitedAmount) || job.forfeitedAmount < 0)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // Strict customer cancellation provenance check (Blocker 1)
  const custProv = classifyCustomerCancellationProvenance(job, TimestampClass);
  if (custProv !== 'NONE') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // Refund state must be clean/uninitiated
  if (job.refundRequestId != null || (job.refundState != null && job.refundState !== 'none') ||
      job.refundNextAttemptAt != null || job.razorpayRefundId != null ||
      job.refundConfirmedAt != null || job.refundedAmountPaise != null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 2. OFFER (Blocker 5 + Audit B1 & B3)
  if (!offer || typeof offer !== 'object') throw new DispatchError('DOCUMENT_NOT_FOUND');
  if (!exactKeys(offer, OFFER_EXACT_KEYS)) throw new DispatchError('OFFER_INVALID');
  if (offer.status !== 'accepted') throw new DispatchError('OFFER_NOT_ACCEPTED');
  if (offer.jobId !== jobId) throw new DispatchError('OFFER_BINDING_MISMATCH');
  if (offer.driverId !== driverUid) throw new DispatchError('OFFER_DRIVER_MISMATCH');
  if (offer.dispatchGeneration !== job.dispatchGeneration) throw new DispatchError('OFFER_GENERATION_MISMATCH');
  if (!Number.isSafeInteger(offer.candidateIndex) || offer.candidateIndex < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!Number.isSafeInteger(offer.roundIndex) || offer.roundIndex < 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  if (!isAuthoritativeTimestamp(offer.createdAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.updatedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.offeredAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.expiresAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!isAuthoritativeTimestamp(offer.acceptedAt, TimestampClass)) throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  if (!Object.hasOwn(offer, 'completedAt') || offer.completedAt !== null ||
      !Object.hasOwn(offer, 'inProgressAt') || offer.inProgressAt !== null ||
      offer.resolvedAt !== null || offer.resolutionReason !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  // F1: Timeout-task relational integrity
  const { taskIdForOfferTimeout } = require('../services/taskQueueService');
  if (offer.timeoutTaskState === 'pending') {
    if (offer.timeoutTaskId !== null) {
      throw new DispatchError('OFFER_INVALID');
    }
  } else if (offer.timeoutTaskState === 'enqueued') {
    if (typeof offer.timeoutTaskId !== 'string' || offer.timeoutTaskId.length === 0) {
      throw new DispatchError('OFFER_INVALID');
    }
    let expectedTaskId;
    try {
      expectedTaskId = taskIdForOfferTimeout(jobId, offerId, offer.dispatchGeneration);
    } catch {
      throw new DispatchError('OFFER_INVALID');
    }
    if (offer.timeoutTaskId !== expectedTaskId) {
      throw new DispatchError('OFFER_INVALID');
    }
  } else if (offer.timeoutTaskState === 'not_required') {
    if (offer.timeoutTaskId !== null) {
      throw new DispatchError('OFFER_INVALID');
    }
  } else {
    throw new DispatchError('OFFER_INVALID');
  }
  if (offer.driverCommissionPaise !== job.driverCommissionPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (offer.requestedTruckType !== 'flatbed' && offer.requestedTruckType !== 'pulling') {
    throw new DispatchError('OFFER_INVALID');
  }
  if (offer.requestedTruckType !== job.requestedTruckType) {
    throw new DispatchError('OFFER_INVALID');
  }
  // F3: Legal zero informational fare
  if (!Number.isSafeInteger(offer.estimatedFarePaise) || offer.estimatedFarePaise < 0) {
    throw new DispatchError('OFFER_INVALID');
  }
  if (!Number.isSafeInteger(job.estimatedFarePaise) || job.estimatedFarePaise < 0) {
    throw new DispatchError('OFFER_INVALID');
  }
  if (offer.estimatedFarePaise !== job.estimatedFarePaise) {
    throw new DispatchError('OFFER_INVALID');
  }
  // Routing & coordinates projections
  if (!validCoords(offer.pickupCoords) || !validCoords(offer.destCoords)) {
    throw new DispatchError('OFFER_INVALID');
  }
  if (!validCoords(job.pickupCoords) || !validCoords(job.destCoords)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (offer.pickupCoords.lat !== job.pickupCoords.lat || offer.pickupCoords.lng !== job.pickupCoords.lng) {
    throw new DispatchError('OFFER_INVALID');
  }
  if (offer.destCoords.lat !== job.destCoords.lat || offer.destCoords.lng !== job.destCoords.lng) {
    throw new DispatchError('OFFER_INVALID');
  }
  const validOfferDistance = offer.pickupRoutedDistanceMeters === null || finiteNonnegative(offer.pickupRoutedDistanceMeters);
  const validOfferEta = offer.pickupEtaSeconds === null || finiteNonnegative(offer.pickupEtaSeconds);
  if (!validOfferDistance || !validOfferEta) {
    throw new DispatchError('OFFER_INVALID');
  }
  validateStoredCancellationPolicySnapshot(offer.cancellationPolicySnapshot, TimestampClass);

  // Chronology & timestamp binding (User Lock 2 + Blocker 6 + Audit B3)
  const policyCapturedAt = offer.cancellationPolicySnapshot.capturedAt;
  if (!isAuthoritativeTimestamp(policyCapturedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampsEqual(policyCapturedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampsEqual(job.acceptedAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampsEqual(originalDebit.createdAt, job.acceptedAt, TimestampClass)) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.createdAt, offer.offeredAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.offeredAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.offeredAt, offer.acceptedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThan(offer.acceptedAt, offer.expiresAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (!timestampLessThanOrEqual(offer.acceptedAt, offer.updatedAt, TimestampClass)) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  // F4: Exact 45-second immutable offer lifetime
  if (offer.expiresAt.seconds !== offer.offeredAt.seconds + 45 ||
      offer.expiresAt.nanoseconds !== offer.offeredAt.nanoseconds) {
    throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
  }
  if (typeof offer.offeredAt.toMillis === 'function' && typeof offer.expiresAt.toMillis === 'function') {
    if (offer.expiresAt.toMillis() !== offer.offeredAt.toMillis() + 45000) {
      throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    }
  }
  // F5: Cancellation event must not precede acceptance
  if (cancellationEventAt != null) {
    if (!timestampLessThanOrEqual(job.acceptedAt, cancellationEventAt, TimestampClass)) {
      throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
    }
  }

  // 3. RUN (Blocker 5 + Audit B1 & B3)
  validateCanonicalAssignedRun({
    run,
    job,
    offer,
    jobId,
    offerId,
    driverUid,
    TimestampClass,
  });
  if (!Array.isArray(run.candidates) || run.candidates.length === 0) throw new DispatchError('ACCEPTANCE_CONFLICT');
  const candidate = run.candidates[offer.candidateIndex];
  if (!candidate || candidate.driverId !== driverUid || candidate.outcome !== 'accepted') {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (candidate.roundIndex !== offer.roundIndex) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (candidate.reasonCode !== null) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (candidate.matrixDistanceMeters !== offer.pickupRoutedDistanceMeters) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (candidate.matrixEtaSeconds !== offer.pickupEtaSeconds) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!Array.isArray(run.attemptedDriverIds) || !run.attemptedDriverIds.includes(driverUid)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }
  if (!Array.isArray(run.excludedDriverIds) || run.excludedDriverIds.includes(driverUid)) {
    throw new DispatchError('ACCEPTANCE_CONFLICT');
  }

  // 4. DRIVER (Blocker 2)
  validateCanonicalDriverForCancellation(driver, TimestampClass, currentMonth);
  if (driver.activeOfferId !== null) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');
  if (driver.activeJobId !== jobId) throw new DispatchError('DRIVER_ENGAGEMENT_MISMATCH');

  // 5. ORIGINAL DEBIT LEDGER
  if (!originalDebit || typeof originalDebit !== 'object') throw new DispatchError('LEDGER_INVALID');
  if (!exactKeys(originalDebit, WALLET_EXACT_KEYS)) throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.operationId !== expectedLedgerId) throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.driverId !== driverUid || originalDebit.jobId !== jobId || originalDebit.offerId !== offerId) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebit.type !== 'commission_debit') throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.commissionPaise !== job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.forfeiturePaise !== 0 || originalDebit.creditPaise !== 0) throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.deltaPaise !== -job.driverCommissionPaise) throw new DispatchError('LEDGER_INVALID');
  if (!Number.isSafeInteger(originalDebit.balanceBeforePaise) || originalDebit.balanceBeforePaise < 0 ||
      !Number.isSafeInteger(originalDebit.balanceAfterPaise) || originalDebit.balanceAfterPaise < 0) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebit.balanceBeforePaise - job.driverCommissionPaise !== originalDebit.balanceAfterPaise) {
    throw new DispatchError('LEDGER_INVALID');
  }
  if (originalDebit.cancellationPolicyEvidence !== null) throw new DispatchError('LEDGER_INVALID');
  if (originalDebit.sourceType !== 'driver' || originalDebit.actorUid !== driverUid) throw new DispatchError('LEDGER_INVALID');
  if (!isAuthoritativeTimestamp(originalDebit.createdAt, TimestampClass)) throw new DispatchError('LEDGER_INVALID');
  validateRequestIdAttribution(offer, originalDebit);

  // 6. CREDIT LEDGER (must NOT exist before cancellation)
  if (creditExists) {
    throw new DispatchError('LEDGER_ALREADY_EXISTS');
  }

  return true;
}

module.exports = {
  DispatchError, POLICY_KEYS, nonnegative, positive, finiteNonnegative, exactKeys,
  absent, boundedCode, timestampMillis, validCoords, driverCoords, validateDispatchConfig, materializeWorkflow,
  validatePaidJob, assertNoCancellation, assertAuthority, driverEligibility, validateRun, validateActiveOfferRun,
  validateCanonicalAssignedRun, compareTimestamps, timestampsEqual, timestampLessThanOrEqual, timestampLessThan,
  validateAcceptanceCancellationProvenance, validateAcceptanceDriverEligibility, validateCancellationPolicy,
  buildCancellationPolicySnapshot, isAuthoritativeTimestamp, validateCanonicalAcceptedOccurrence,
  validateCancellationRamp, validateStoredCancellationPolicySnapshot, validateCleanOfferedJobState,
  validateCanonicalDeclineReceipt,
  OUTBOX_ALLOWED_STATES, OUTBOX_ALLOWED_ERROR_CODES, OUTBOX_EXACT_KEYS,
  validateCanonicalOutboxRecord, validateCanonicalStartReceipt, validateCanonicalCompleteReceipt,
  validateCanonicalStartingAcceptedOccurrence, validateCanonicalInProgressOccurrence,
  validateCanonicalCustomerCancelledOfferedOccurrence, validateCanonicalCustomerCancelledAcceptedOccurrence,
  validateCanonicalCustomerCancelledInProgressOccurrence, validateCanonicalTerminalCustomerCancellationOccurrence,
  validateRequestIdAttribution,
  getIstMonthString, evaluateDriverCancellation, validateCanonicalDriverCancelReceipt,
  validateCanonicalAcceptedDriverCancellationOccurrence,
  classifyCustomerCancellationProvenance, validateCanonicalDriverForCancellation, calculateForfeitureHalfUp,
  validateTerminalAcceptedCustomerCancellationProvenance,
  OFFER_EXACT_KEYS, WALLET_EXACT_KEYS, CANCELLATION_EVIDENCE_EXACT_KEYS,
};
