'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { haversineDistance } = require('../utils/haversine');
const { createOlaMapsClient, OlaProviderError } = require('../services/olaMapsClient');
const { createUsageCounterService, UsageAuthorizationError } = require('../services/usageCounterService');
const {
  DispatchError, POLICY_KEYS, positive, finiteNonnegative, timestampMillis, materializeWorkflow,
  validatePaidJob, validateDispatchConfig, assertAuthority, driverCoords, driverEligibility, validateRun,
} = require('./dispatchValidation');

const OFFER_LIFETIME_MS = 45000;
const STALE_CODES = new Set(['LEASE_EXPIRED', 'LEASE_DISPLACED', 'JOB_NOT_PENDING', 'CANCELLATION_PRECEDENCE']);

function offerIdFor(jobId, driverId, generation) {
  if (![jobId, driverId].every(id => typeof id === 'string' && id.length && !id.includes('/')) ||
      !positive(generation)) throw new DispatchError('OFFER_ID_INVALID');
  return 'offer_' + crypto.createHash('sha256').update(JSON.stringify([jobId, driverId, generation]), 'utf8').digest('hex');
}

function createDispatchService({
  db = getFirestore(), TimestampClass = Timestamp, now = () => new Date(),
  randomUUID = () => crypto.randomUUID(), olaClient = createOlaMapsClient(),
  usageService = createUsageCounterService({ db, TimestampClass, now }),
  defaultLeaseDurationMs = 30000, retryDelayMs = 15000,
} = {}) {
  if (!positive(defaultLeaseDurationMs) || !positive(retryDelayMs)) throw new DispatchError('RUNTIME_CONFIG_INVALID');
  const jobRefFor = jobId => {
    if (typeof jobId !== 'string' || !jobId || jobId.includes('/')) throw new DispatchError('JOB_ID_INVALID');
    return db.collection('jobs').doc(jobId);
  };
  const runRefFor = (jobId, runId) => db.collection('jobs/' + jobId + '/dispatch_runs').doc(runId);
  const timestamp = ms => TimestampClass.fromMillis(ms);

  async function bootstrapDispatchJob(jobId) {
    const jobRef = jobRefFor(jobId);
    return db.runTransaction(async tx => {
      const snap = await tx.get(jobRef);
      if (!snap.exists || snap.data().status !== 'pending_offer') return { ready: false, reason: 'JOB_NOT_PENDING' };
      const { job, patch } = materializeWorkflow(snap.data());
      try { validatePaidJob(job); }
      catch (error) { return { ready: false, reason: error.code }; }
      if (Object.keys(patch).length) tx.update(jobRef, patch);
      return { ready: true };
    });
  }

  async function claimDispatch(jobId, ownerToken, leaseDurationMs = defaultLeaseDurationMs) {
    if (typeof ownerToken !== 'string' || !ownerToken || !positive(leaseDurationMs)) throw new DispatchError('CLAIM_INVALID');
    const jobRef = jobRefFor(jobId);
    return db.runTransaction(async tx => {
      const snap = await tx.get(jobRef);
      // Never use a time captured outside a retryable transaction callback.
      const nowMs = now().getTime();
      if (!snap.exists) return { claimed: false, reason: 'JOB_NOT_FOUND' };
      if (snap.data().status !== 'pending_offer') return { claimed: false, reason: 'JOB_NOT_PENDING' };
      const { job, patch } = materializeWorkflow(snap.data());
      try { validatePaidJob(job); }
      catch (error) { return { claimed: false, reason: error.code }; }
      if (timestampMillis(job.dispatchLeaseUntil) > nowMs) return { claimed: false, reason: 'BUSY_LEASE_ACTIVE' };
      // A token cannot renew its own expired authority; each invocation uses a fresh token.
      if (job.dispatchLeaseOwner === ownerToken) return { claimed: false, reason: 'LEASE_EXPIRED' };
      if (job.dispatchState === 'retry_wait' && timestampMillis(job.dispatchNextActionAt) > nowMs) {
        return { claimed: false, reason: 'RETRY_NOT_DUE' };
      }
      if (job.dispatchState === 'operational_hold') return { claimed: false, reason: 'OPERATIONAL_HOLD' };
      const update = { ...patch, dispatchState: 'claimed', dispatchLeaseOwner: ownerToken,
        dispatchLeaseUntil: timestamp(nowMs + leaseDurationMs), updatedAt: timestamp(nowMs) };
      tx.update(jobRef, update);
      return { claimed: true, job: { ...job, ...update } };
    });
  }

  async function setSelecting(jobId, ownerToken) {
    return db.runTransaction(async tx => {
      const ref = jobRefFor(jobId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new DispatchError('JOB_NOT_PENDING');
      const job = snap.data();
      const nowMs = now().getTime();
      assertAuthority(job, ownerToken, nowMs);
      if (job.dispatchState !== 'claimed') throw new DispatchError('DISPATCH_STATE_INVALID');
      tx.update(ref, { dispatchState: 'selecting', updatedAt: timestamp(nowMs) });
      return { ...job, dispatchState: 'selecting' };
    });
  }

  async function processDispatchJob(jobId, options = {}) {
    const ownerToken = options.ownerToken || randomUUID();
    const claim = await claimDispatch(jobId, ownerToken, options.leaseDurationMs ?? defaultLeaseDurationMs);
    if (!claim.claimed) return { dispatched: false, claimed: false, reason: claim.reason };
    try {
      const job = await setSelecting(jobId, ownerToken);
      const configSnap = await db.collection('dispatch_config').doc('main').get();
      const config = validateDispatchConfig(configSnap.exists ? configSnap.data() : null);
      let runId = job.dispatchRunId;
      if (runId === null) {
        // Stage 2 creates only the first generation. Missing/corrupt referenced
        // runs never silently start a replacement generation or erase history.
        if (job.dispatchGeneration !== 0) throw new DispatchError('RUN_INVALID');
        runId = '1';
        const candidates = await buildCandidateList(job, config, { jobId, ownerToken });
        await db.runTransaction(async tx => {
          const jobRef = jobRefFor(jobId);
          const runRef = runRefFor(jobId, runId);
          const freshSnap = await tx.get(jobRef);
          const existing = await tx.get(runRef);
          const currentConfig = await tx.get(db.collection('dispatch_config').doc('main'));
          if (!freshSnap.exists) throw new DispatchError('JOB_NOT_PENDING');
          const fresh = freshSnap.data();
          const nowMs = now().getTime();
          assertAuthority(fresh, ownerToken, nowMs);
          validateDispatchConfig(currentConfig.exists ? currentConfig.data() : null);
          if (fresh.dispatchState !== 'selecting' || fresh.dispatchRunId !== null ||
              fresh.dispatchGeneration !== 0 || existing.exists || !sameSearchJob(job, fresh)) {
            throw new DispatchError('RUN_CONFLICT');
          }
          const run = {
            jobId, generation: 1, status: 'active', policyVersion: config.version,
            policySnapshot: Object.fromEntries(POLICY_KEYS.map(key => [key, config[key]])),
            candidates, nextCandidateIndex: 0, attemptedDriverIds: [], excludedDriverIds: [],
            currentOfferId: null, createdAt: timestamp(nowMs), updatedAt: timestamp(nowMs), finalizedAt: null,
          };
          validateRun(run, { ...fresh, dispatchRunId: runId, dispatchGeneration: 1 }, jobId, runId);
          tx.create(runRef, run);
          tx.update(jobRef, { dispatchGeneration: 1, dispatchRunId: runId, updatedAt: timestamp(nowMs) });
        });
      }
      return await attemptNextCandidateOffer(jobId, runId, ownerToken);
    } catch (error) {
      if (STALE_CODES.has(error.code)) return { dispatched: false, reason: error.code };
      return recordFailure(jobId, ownerToken, error);
    }
  }

  async function buildCandidateList(job, config, dispatchClaim) {
    const capability = job.requestedTruckType === 'flatbed' ? 'canFlatbed' : 'canPulling';
    const snapshot = await db.collection('drivers')
      .where('verificationStatus', '==', 'approved').where('isOnDuty', '==', true)
      .where(capability, '==', true).where('activeJobId', '==', null)
      .where('activeOfferId', '==', null).where('walletBalance', '>=', job.driverCommissionPaise).get();
    const nowMs = now().getTime();
    const pool = [];
    for (const doc of snapshot.docs) {
      const driver = doc.data();
      if (driverEligibility(driver, job, config, nowMs)) continue;
      const coords = driverCoords(driver.location);
      pool.push({ driverId: doc.id, coords, haversineDistanceKm: haversineDistance(coords, job.pickupCoords) });
    }
    const candidates = [];
    const seen = new Set();
    // The run is created only AFTER every finite round has completed. A failed
    // query/ranking step cannot leave a partial list masquerading as exhaustion.
    for (let roundIndex = 0; roundIndex < config.radiusKmSequence.length; roundIndex++) {
      const remaining = config.maxUniqueCandidatesPerGeneration - candidates.length;
      if (!remaining) break;
      const shortlist = pool.filter(d => !seen.has(d.driverId) && d.haversineDistanceKm <= config.radiusKmSequence[roundIndex])
        .sort((a, b) => a.haversineDistanceKm - b.haversineDistanceKm || compareUid(a.driverId, b.driverId))
        .slice(0, Math.min(remaining, config.maxMatrixShortlistPerRound));
      if (!shortlist.length) continue;
      let matrix = null;
      if (config.olaMonthlyPairCap !== null) {
        try {
          matrix = await olaClient.getDistanceMatrix({
            origins: shortlist.map(d => d.coords), destinations: [job.pickupCoords],
            authorizeAttempt: args => usageService.reserveOlaMatrixUsage({ ...args, dispatchClaim }),
          });
          if (!Array.isArray(matrix) || matrix.length !== shortlist.length ||
              matrix.some(row => !Array.isArray(row) || row.length !== 1 || row[0]?.status !== 'OK' ||
                !finiteNonnegative(row[0].durationSeconds) || !finiteNonnegative(row[0].distanceMeters))) {
            throw new OlaProviderError('OLA_MALFORMED_RESPONSE');
          }
        } catch (error) {
          if (!(error instanceof OlaProviderError) || !error.degradedAllowed) throw error;
          matrix = null;
        }
      }
      const ranked = shortlist.map((driver, i) => ({
        driverId: driver.driverId, roundIndex, haversineDistanceKm: driver.haversineDistanceKm,
        matrixEtaSeconds: matrix ? matrix[i][0].durationSeconds : null,
        matrixDistanceMeters: matrix ? matrix[i][0].distanceMeters : null,
        rankingMode: matrix ? 'ola' : 'haversine_degraded', outcome: 'pending', reasonCode: null,
      }));
      if (matrix) ranked.sort((a, b) => a.matrixEtaSeconds - b.matrixEtaSeconds ||
        a.matrixDistanceMeters - b.matrixDistanceMeters || compareUid(a.driverId, b.driverId));
      for (const candidate of ranked) { seen.add(candidate.driverId); candidates.push(candidate); }
    }
    return candidates;
  }

  async function attemptNextCandidateOffer(jobId, runId, ownerToken) {
    // The cursor and candidate are selected INSIDE the transaction. A retry
    // cannot apply a stale array index to a different current run/history.
    while (true) {
      const result = await db.runTransaction(async tx => {
        const jobRef = jobRefFor(jobId);
        const runRef = runRefFor(jobId, runId);
        const jobSnap = await tx.get(jobRef);
        const runSnap = await tx.get(runRef);
        const configSnap = await tx.get(db.collection('dispatch_config').doc('main'));
        if (!jobSnap.exists) throw new DispatchError('JOB_NOT_PENDING');
        const job = jobSnap.data();
        assertAuthority(job, ownerToken, now().getTime());
        if (job.dispatchState !== 'selecting') throw new DispatchError('DISPATCH_STATE_INVALID');
        validateDispatchConfig(configSnap.exists ? configSnap.data() : null);
        const run = validateRun(runSnap.exists ? runSnap.data() : null, job, jobId, runId);
        const index = run.nextCandidateIndex;
        if (index === run.candidates.length) {
          // Exact terminal cursor/history has been validated in this transaction.
          const refundRef = db.collection('refund_requests').doc(jobId);
          const refundSnap = await tx.get(refundRef);
          if (refundSnap.exists) throw new DispatchError('REFUND_CONFLICT');
          if (!/^[A-Za-z0-9_-]+$/.test(jobId) || !positive(job.bookingFeePaise)) throw new DispatchError('REFUND_IDENTITY_INVALID');
          const nowMs = now().getTime();
          assertAuthority(job, ownerToken, nowMs); // After all reads; re-evaluated on callback retry.
          const at = timestamp(nowMs);
          const refund = {
            operationId: jobId, jobId, razorpayPaymentId: job.razorpayPaymentId,
            amountPaise: job.bookingFeePaise, reason: 'no_driver_found',
            providerIdempotencyKey: 'refund_no_driver_found_' + jobId,
            providerRequestHash: crypto.createHash('sha256').update(JSON.stringify({
              paymentId: job.razorpayPaymentId, amount: job.bookingFeePaise,
            }), 'utf8').digest('hex'),
            state: 'pending', ownerToken: null, leaseUntil: null, nextAttemptAt: at,
            reconciliationNextAttemptAt: null, reconciliationAttempts: 0, razorpayRefundId: null,
            confirmationSource: null, attemptCount: 0, lastErrorCode: null,
            createdAt: at, updatedAt: at, submittedAt: null, confirmedAt: null,
          };
          tx.create(refundRef, refund);
          tx.update(runRef, { status: 'exhausted', finalizedAt: at, updatedAt: at });
          tx.update(jobRef, {
            status: 'cancelled_system', dispatchState: 'closed', cancelledBy: 'system',
            cancellationReason: 'no_driver_found', cancelledAt: at,
            refundRequestId: jobId, refundState: 'pending', refundNextAttemptAt: at,
            dispatchLeaseOwner: null, dispatchLeaseUntil: null, dispatchNextActionAt: null,
            dispatchLastFailure: null, stateVersion: job.stateVersion + 1, updatedAt: at,
          });
          return { dispatched: false, exhausted: true, status: 'cancelled_system', cancellationReason: 'no_driver_found' };
        }
        const candidate = run.candidates[index];
        const driverRef = db.collection('drivers').doc(candidate.driverId);
        const offerId = offerIdFor(jobId, candidate.driverId, run.generation);
        const offerRef = db.collection('job_offers').doc(offerId);
        const driverSnap = await tx.get(driverRef);
        const offerSnap = await tx.get(offerRef);
        const nowMs = now().getTime();
        assertAuthority(job, ownerToken, nowMs);
        // An offered occurrence with inconsistent projections is not a retry:
        // never overwrite an existing document, even when its tuple matches.
        if (offerSnap.exists) throw new DispatchError('OFFER_CONFLICT');
        const driver = driverSnap.exists ? driverSnap.data() : null;
        let reason = driverEligibility(driver, job, run.policySnapshot, nowMs);
        if (!reason && haversineDistance(driverCoords(driver.location), job.pickupCoords) >
            run.policySnapshot.radiusKmSequence[candidate.roundIndex]) reason = 'driver_outside_radius';
        const at = timestamp(nowMs);
        if (reason) {
          const candidates = run.candidates.map((c, i) => i === index ? { ...c, outcome: 'skipped', reasonCode: reason } : c);
          tx.update(runRef, { candidates, nextCandidateIndex: index + 1, updatedAt: at });
          return { skipped: true };
        }
        const expires = timestamp(nowMs + OFFER_LIFETIME_MS);
        const offer = {
          jobId, driverId: candidate.driverId, dispatchGeneration: run.generation,
          candidateIndex: index, roundIndex: candidate.roundIndex, status: 'offered',
          offeredAt: at, expiresAt: expires, resolvedAt: null, resolutionReason: null,
          acceptedAt: null, inProgressAt: null, completedAt: null, timeoutTaskId: null,
          timeoutTaskState: 'pending', acceptRequestId: null, cancellationPolicySnapshot: null,
          pickupCoords: job.pickupCoords, destCoords: job.destCoords, requestedTruckType: job.requestedTruckType,
          pickupRoutedDistanceMeters: candidate.matrixDistanceMeters, pickupEtaSeconds: candidate.matrixEtaSeconds,
          estimatedFarePaise: job.estimatedFarePaise, driverCommissionPaise: job.driverCommissionPaise,
          createdAt: at, updatedAt: at,
        };
        tx.create(offerRef, offer);
        tx.update(driverRef, { activeOfferId: offerId, updatedAt: at });
        tx.update(runRef, {
          candidates: run.candidates.map((c, i) => i === index ? { ...c, outcome: 'offered' } : c),
          currentOfferId: offerId, attemptedDriverIds: [...run.attemptedDriverIds, candidate.driverId],
          nextCandidateIndex: index + 1, updatedAt: at,
        });
        tx.update(jobRef, {
          status: 'offered', dispatchState: 'offered', offeredTo: candidate.driverId,
          currentOfferId: offerId, offeredAt: at, offerExpiresAt: expires,
          dispatchLeaseOwner: null, dispatchLeaseUntil: null, dispatchNextActionAt: null,
          dispatchLastFailure: null, stateVersion: job.stateVersion + 1, updatedAt: at,
        });
        return { dispatched: true, offerId, driverId: candidate.driverId, candidateIndex: index, generation: run.generation };
      });
      if (!result.skipped) return result;
    }
  }

  async function recordFailure(jobId, ownerToken, error) {
    const failure = classifyFailure(error);
    try {
      return await db.runTransaction(async tx => {
        const ref = jobRefFor(jobId);
        const snap = await tx.get(ref);
        if (!snap.exists) return { dispatched: false, reason: 'JOB_NOT_PENDING' };
        const nowMs = now().getTime();
        assertAuthority(snap.data(), ownerToken, nowMs);
        const state = failure.retryable ? 'retry_wait' : 'operational_hold';
        tx.update(ref, {
          dispatchState: state, dispatchLeaseOwner: null, dispatchLeaseUntil: null,
          dispatchNextActionAt: failure.retryable ? timestamp(nowMs + retryDelayMs) : null,
          dispatchLastFailure: { ...failure, occurredAt: timestamp(nowMs) }, updatedAt: timestamp(nowMs),
        });
        return { dispatched: false, state, reason: failure.code };
      });
    } catch (persistError) {
      if (STALE_CODES.has(persistError.code)) return { dispatched: false, reason: persistError.code };
      if (persistError instanceof DispatchError && ['JOB_INVALID', 'ASSIGNMENT_INVALID',
        'REFUND_STATE_INVALID', 'DISPATCH_STATE_INVALID'].includes(persistError.code)) {
        // A concurrent malformed-domain write revokes dispatch eligibility too.
        // Preserve it for operations instead of misreporting a transport outage.
        return { dispatched: false, reason: persistError.code };
      }
      // A database outage cannot safely persist progress. The existing lease
      // expires, and the status-only reconciler rediscovers the paid job.
      throw new DispatchError('FAILURE_PERSISTENCE_UNAVAILABLE', { retryable: true });
    }
  }

  return { triggerDispatch: processDispatchJob, processDispatchJob, bootstrapDispatchJob, claimDispatch };
}

function sameSearchJob(a, b) {
  return ['pickupCoords', 'destCoords', 'requestedTruckType', 'bookingFeePaise', 'driverCommissionPaise',
    'estimatedFarePaise', 'razorpayPaymentId', 'razorpayPaymentLinkId', 'paymentConfirmedAt']
    .every(key => isDeepStrictEqual(a[key], b[key]));
}
function compareUid(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function classifyFailure(error) {
  // Never persist arbitrary error.code/source, provider bodies, or messages.
  if (error instanceof DispatchError) {
    const codes = ['CONFIG_INVALID', 'RUN_INVALID', 'RUN_CONFLICT', 'DRIVER_INVALID', 'REFUND_CONFLICT',
      'REFUND_IDENTITY_INVALID', 'OFFER_CONFLICT', 'DISPATCH_STATE_INVALID', 'JOB_INVALID',
      'ASSIGNMENT_INVALID', 'REFUND_STATE_INVALID', 'RUNTIME_CONFIG_INVALID'];
    return { code: codes.includes(error.code) ? error.code : 'INTERNAL_ERROR', source: 'dispatch_worker', retryable: false };
  }
  if (error instanceof UsageAuthorizationError) return {
    code: ['USAGE_COUNTER_INVALID', 'USAGE_COUNTER_OVERFLOW', 'USAGE_PAIRS_INVALID'].includes(error.code) ? error.code : 'USAGE_AUTHORIZATION_FAILED',
    source: 'usage_counter', retryable: false,
  };
  if (error instanceof OlaProviderError) return {
    code: ['OLA_API_KEY_MISSING', 'OLA_CONFIG_INVALID', 'OLA_HTTP_ERROR', 'OLA_MALFORMED_RESPONSE',
      'OLA_AUTHORIZATION_MISSING', 'OLA_AUTHORIZATION_FAILED', 'OLA_LOCAL_ERROR'].includes(error.code) ? error.code : 'OLA_PROVIDER_ERROR',
    source: 'ola_provider', retryable: false,
  };
  // Firestore transient codes only. Unknown programming/auth/config failures hold.
  const retryable = [4, 8, 10, 13, 14, 'deadline-exceeded', 'resource-exhausted', 'aborted', 'internal', 'unavailable'].includes(error?.code);
  return { code: retryable ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INTERNAL_ERROR', source: 'dispatch_worker', retryable };
}

let defaultService;
function getDefaultDispatchService() {
  if (!defaultService) defaultService = createDispatchService();
  return defaultService;
}
module.exports = { DispatchError, createDispatchService, offerIdFor,
  triggerDispatch: (...args) => getDefaultDispatchService().triggerDispatch(...args),
  bootstrapDispatchJob: (...args) => getDefaultDispatchService().bootstrapDispatchJob(...args) };
