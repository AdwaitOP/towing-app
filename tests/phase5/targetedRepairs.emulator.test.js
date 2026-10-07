'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GeoPoint } = require('firebase-admin/firestore');

const {
  createPrepareDutyActivationManager,
} = require('../../firebase/functions/src/duty/prepareDutyActivation');
const {
  createStartDutySessionManager,
} = require('../../firebase/functions/src/duty/startDutySession');
const {
  createCancelDutyActivationManager,
} = require('../../firebase/functions/src/duty/cancelDutyActivation');
const {
  createEndDutySessionManager,
} = require('../../firebase/functions/src/duty/endDutySession');
const {
  createReportLocationHeartbeatManager,
} = require('../../firebase/functions/src/duty/reportLocationHeartbeat');
const {
  createRecoverActiveJobSessionManager,
} = require('../../firebase/functions/src/duty/recoverActiveJobSession');
const {
  driverEligibility,
  validateRun,
  validateActiveOfferRun,
  validateCanonicalAssignedRun,
} = require('../../firebase/functions/src/dispatch/dispatchValidation');

const { FakeFirestore, FakeTimestamp } = require('../phase4/fakeDeps');

function createDriver(uid, overrides = {}) {
  return {
    uid,
    name: 'Test Driver',
    phone: '+919876543210',
    truckType: 'flatbed',
    vehicleNumber: 'MH01AB1234',
    verificationStatus: 'approved',
    isOnDuty: false,
    workerReady: false,
    activeDutySessionId: null,
    activeJobId: null,
    activeOfferId: null,
    dutyGeneration: 1,
    walletBalance: 50000,
    canFlatbed: true,
    canPulling: true,
    bannedUntil: null,
    location: new GeoPoint(18.5204, 73.8567),
    locationUpdatedAt: FakeTimestamp.fromMillis(Date.now()),
    createdAt: FakeTimestamp.fromMillis(Date.now()),
    updatedAt: FakeTimestamp.fromMillis(Date.now()),
    ...overrides,
  };
}

test('Phase 5 Stage 3: Targeted Repair Adversarial Tests', async (t) => {
  // 1. PrepareDutyActivation SHA-256 Collision Resistance & Terminal Immutability
  await t.test('1. prepareDutyActivation uses non-colliding SHA-256 derivation and preserves terminal state', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_hash_test';
    await db.collection('drivers').doc(uid).set(createDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });

    // Distinct clientRequestIds with similar characters produce distinct session IDs
    const res1 = await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: 'req/a?b' });
    const res2 = await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: 'req?a/b' });
    assert.notEqual(res1.sessionId, res2.sessionId);

    // Terminal intent immutability: once activated, prep with same clientRequestId throws failed-precondition
    const intentRef = db.collection('drivers').doc(uid).collection('activation_intents').doc(res1.sessionId);
    await intentRef.update({ status: 'activated' });

    await assert.rejects(
      async () => {
        await prepMgr.prepareDutyActivation({ driverUid: uid, clientRequestId: 'req/a?b' });
      },
      (err) => err.code === 'failed-precondition' || err.message.includes('already exists')
    );

    // Verify status was NOT reset to pending
    const snap = await intentRef.get();
    assert.equal(snap.data().status, 'activated');
  });

  // 2. StartDutySession Strict Expiry and Strict Generation Validation
  await t.test('2. startDutySession enforces strict intent expiry and strict integer dutyGeneration', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_start_guard_test';
    await db.collection('drivers').doc(uid).set(createDriver(uid));

    const prepMgr = createPrepareDutyActivationManager({ db });
    const startMgr = createStartDutySessionManager({ db });

    const prepRes = await prepMgr.prepareDutyActivation({ driverUid: uid });
    const sessionId = prepRes.sessionId;
    const intentRef = db.collection('drivers').doc(uid).collection('activation_intents').doc(sessionId);

    // 2A: Expired intent fails closed
    await intentRef.update({ expiresAt: FakeTimestamp.fromMillis(Date.now() - 5000) });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prepRes.generation,
          attemptSeq: prepRes.attemptSeq,
        });
      },
      (err) => err.code === 'deadline-exceeded' || err.message.includes('expired')
    );

    // Reset intent to valid expiry
    await intentRef.update({ expiresAt: FakeTimestamp.fromMillis(Date.now() + 600000) });

    // 2B: Fractional dutyGeneration fails closed
    await db.collection('drivers').doc(uid).update({ dutyGeneration: 1.5 });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prepRes.generation,
          attemptSeq: prepRes.attemptSeq,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('dutyGeneration')
    );

    // 2C: Negative dutyGeneration fails closed
    await db.collection('drivers').doc(uid).update({ dutyGeneration: -1 });
    await assert.rejects(
      async () => {
        await startMgr.startDutySession({
          driverUid: uid,
          sessionId,
          initialLocation: { lat: 18.5204, lng: 73.8567 },
          lifecycleSeq: 1,
          generation: prepRes.generation,
          attemptSeq: prepRes.attemptSeq,
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('dutyGeneration')
    );
  });

  // 3. Worker Readiness Fail-Closed Invariant Matrix in Dispatch Eligibility
  await t.test('3. driverEligibility enforces canonical boolean workerReady === true', async () => {
    const validDriverBase = createDriver('test_driver_elig', {
      isOnDuty: true,
      activeDutySessionId: 'sess_valid',
      dutyGeneration: 2,
    });

    const dummyJob = { requestedTruckType: 'flatbed', driverCommissionPaise: 100 };
    const dummyPolicy = { locationFreshnessSeconds: 120 };
    const nowMs = Date.now();

    // Falsy, truthy non-boolean, and primitive values MUST all fail closed to 'driver_not_ready'
    const nonTrueValues = [
      false,
      null,
      undefined,
      0,
      1,
      '',
      'true',
      'false',
      {},
      [],
      NaN,
    ];

    for (const val of nonTrueValues) {
      const driver = { ...validDriverBase, workerReady: val };
      const reason = driverEligibility(driver, dummyJob, dummyPolicy, nowMs);
      assert.equal(
        reason,
        'driver_not_ready',
        `Expected 'driver_not_ready' for workerReady=${JSON.stringify(val)}, got: ${reason}`
      );
    }

    // Only strictly boolean true is accepted as eligible
    const readyDriver = { ...validDriverBase, workerReady: true };
    const readyReason = driverEligibility(readyDriver, dummyJob, dummyPolicy, nowMs);
    assert.equal(readyReason, null, 'Expected eligible (null) when workerReady === true');
  });

  // 4. Dispatch Run Validators Accept 'driver_not_ready' Without Causing Operational Hold
  await t.test('4. validateRun, validateActiveOfferRun, and validateCanonicalAssignedRun accept driver_not_ready', async () => {
    const policySnapshot = {
      locationFreshnessSeconds: 120,
      radiusKmSequence: [10, 20, 35],
      maxUniqueCandidatesPerGeneration: 30,
      maxMatrixShortlistPerRound: 10,
      rankingPrimary: 'ola_eta_seconds',
      rankingSecondary: 'ola_distance_meters',
      rankingTieBreak: 'driver_uid',
      olaFailureMode: 'bounded_retry_then_haversine_degraded',
    };

    const skippedCandidate = {
      driverId: 'driver_skipped_ready',
      roundIndex: 0,
      haversineDistanceKm: 2.5,
      matrixEtaSeconds: null,
      matrixDistanceMeters: null,
      rankingMode: 'haversine_degraded',
      outcome: 'skipped',
      reasonCode: 'driver_not_ready',
    };

    const offeredCandidate = {
      driverId: 'driver_selected',
      roundIndex: 0,
      haversineDistanceKm: 3.0,
      matrixEtaSeconds: null,
      matrixDistanceMeters: null,
      rankingMode: 'haversine_degraded',
      outcome: 'offered',
      reasonCode: null,
    };

    const acceptedCandidate = {
      driverId: 'driver_selected',
      roundIndex: 0,
      haversineDistanceKm: 3.0,
      matrixEtaSeconds: null,
      matrixDistanceMeters: null,
      rankingMode: 'haversine_degraded',
      outcome: 'accepted',
      reasonCode: null,
    };

    const jobId = 'job_1';
    const runId = '1';
    const job = { dispatchGeneration: 1, dispatchRunId: runId };

    // validateRun must not throw RUN_INVALID when candidate is skipped due to driver_not_ready
    assert.doesNotThrow(() => {
      validateRun(
        {
          jobId,
          generation: 1,
          status: 'active',
          currentOfferId: null,
          finalizedAt: null,
          policyVersion: 1,
          policySnapshot,
          candidates: [skippedCandidate],
          nextCandidateIndex: 1,
          attemptedDriverIds: [],
          excludedDriverIds: [],
          createdAt: FakeTimestamp.fromMillis(Date.now()),
          updatedAt: FakeTimestamp.fromMillis(Date.now()),
        },
        job,
        jobId,
        runId
      );
    });

    // validateActiveOfferRun must not throw
    assert.doesNotThrow(() => {
      validateActiveOfferRun(
        {
          jobId,
          generation: 1,
          status: 'active',
          currentOfferId: 'offer_1',
          finalizedAt: null,
          policyVersion: 1,
          policySnapshot,
          candidates: [skippedCandidate, offeredCandidate],
          nextCandidateIndex: 2,
          attemptedDriverIds: ['driver_selected'],
          excludedDriverIds: [],
          createdAt: FakeTimestamp.fromMillis(Date.now()),
          updatedAt: FakeTimestamp.fromMillis(Date.now()),
        },
        job,
        {
          offerId: 'offer_1',
          driverId: 'driver_selected',
          candidateIndex: 1,
        },
        jobId,
        'offer_1',
        1
      );
    });

    // validateCanonicalAssignedRun must not throw
    assert.doesNotThrow(() => {
      validateCanonicalAssignedRun({
        run: {
          jobId,
          generation: 1,
          status: 'assigned',
          currentOfferId: 'offer_1',
          finalizedAt: null,
          policyVersion: 1,
          policySnapshot,
          candidates: [skippedCandidate, acceptedCandidate],
          nextCandidateIndex: 2,
          attemptedDriverIds: ['driver_selected'],
          excludedDriverIds: [],
          createdAt: FakeTimestamp.fromMillis(Date.now()),
          updatedAt: FakeTimestamp.fromMillis(Date.now()),
        },
        job,
        offer: {
          offerId: 'offer_1',
          driverId: 'driver_selected',
          candidateIndex: 1,
        },
        jobId,
        offerId: 'offer_1',
        driverUid: 'driver_selected',
        TimestampClass: FakeTimestamp,
      });
    });
  });

  // 5. Concurrency Fencing and Canonical ActiveJobId in RecoverActiveJobSession
  await t.test('5. recoverActiveJobSession enforces canonical activeJobId and concurrency fencing', async () => {
    const db = new FakeFirestore();
    const uid = 'driver_rec_test';
    const staleTime = FakeTimestamp.fromMillis(Date.now() - 120000); // 120s ago

    await db.collection('drivers').doc(uid).set(createDriver(uid, {
      isOnDuty: true,
      activeJobId: 'job_valid_123',
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      locationUpdatedAt: staleTime,
    }));

    const recMgr = createRecoverActiveJobSessionManager({ db });

    // 5A: Malformed activeJobId with whitespace fails closed
    await db.collection('drivers').doc(uid).update({ activeJobId: 'job 123 with space' });
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_old',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job 123 with space',
        });
      },
      (err) => err.code === 'failed-precondition' && err.message.includes('Malformed')
    );

    // Reset to valid canonical ID
    await db.collection('drivers').doc(uid).update({ activeJobId: 'job_valid_123' });

    // 5B: First recovery call succeeds and sets lastRecoveredAt
    const result1 = await recMgr.recoverActiveJobSession({
      driverUid: uid,
      activeDutySessionId: 'sess_old',
      dutyGeneration: 1,
      lifecycleSeq: 1,
      expectedActiveJobId: 'job_valid_123',
    });
    assert.equal(result1.status, 'recovered');
    assert.ok(result1.sessionId);

    // 5C: Competing concurrent recovery against the same document immediately fails closed
    // because silence was reset by lastRecoveredAt barrier
    await assert.rejects(
      async () => {
        await recMgr.recoverActiveJobSession({
          driverUid: uid,
          activeDutySessionId: 'sess_old',
          dutyGeneration: 1,
          lifecycleSeq: 1,
          expectedActiveJobId: 'job_valid_123',
        });
      },
      (err) => err.code === 'failed-precondition'
    );
  });
});
