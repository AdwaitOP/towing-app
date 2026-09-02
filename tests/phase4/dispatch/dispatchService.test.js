'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDispatchService, offerIdFor } = require('../../../firebase/functions/src/dispatch/dispatchService');
const { validateDispatchConfig, materializeWorkflow, validatePaidJob } = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { createOlaMapsClient } = require('../../../firebase/functions/src/services/olaMapsClient');
const { FakeFirestore, FakeTimestamp: T } = require('../fakeDeps');
const { paidJob, config, driver, matrixBody } = require('../fixtures');
const nowMs = Date.parse('2026-09-02T10:00:00Z');
function setup(overrides = {}) {
  const db = new FakeFirestore();
  db.seed('jobs', 'job', paidJob(T, nowMs));
  db.seed('dispatch_config', 'main', config(T, nowMs));
  db.seed('drivers', 'driver', driver(T, nowMs));
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs), ...overrides });
  return { db, service };
}
test('null cap is valid: Haversine offer, exact 26-field projection, fixed 45s lifetime', async () => {
  const { db, service } = setup({ olaClient: { getDistanceMatrix: () => { throw new Error('must not call Ola'); } } });
  const result = await service.triggerDispatch('job', { offerLifetimeMs: 1 });
  assert.equal(result.dispatched, true);
  const offer = db.read('job_offers', result.offerId);
  const schema = require('../../../firebase/seed/job_offers_schema.json');
  assert.deepEqual(Object.keys(offer).sort(), Object.keys(schema).filter(k => !k.startsWith('_')).sort());
  assert.equal(Object.keys(offer).length, 26);
  assert.equal(offer.expiresAt.toMillis() - offer.offeredAt.toMillis(), 45000);
  assert.equal(offer.customerPhone, undefined);
  const run = db.read('jobs/job/dispatch_runs', '1');
  assert.equal(run.candidates[0].rankingMode, 'haversine_degraded');
  assert.equal(run.policySnapshot.olaMonthlyPairCap, undefined);
  assert.equal(db.read('jobs', 'job').dispatchRunId, '1');
});
test('capability comes from server canPulling and never the truckType label', async () => {
  const { db, service } = setup();
  db.seed('jobs', 'job', paidJob(T, nowMs, { requestedTruckType: 'pulling' }));
  db.seed('drivers', 'driver', driver(T, nowMs, { truckType: 'pulling' }));
  db.seed('drivers', 'pulling_driver', driver(T, nowMs, { canFlatbed: false, canPulling: true, truckType: 'flatbed' }));
  assert.equal((await service.triggerDispatch('job')).driverId, 'pulling_driver');
});
test('Ola order is ETA then routed distance then UID', async () => {
  const { db } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: 100 }));
  for (const id of ['a', 'b', 'c']) db.seed('drivers', id, driver(T, nowMs));
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs),
    olaClient: createOlaMapsClient({ apiKey: 'test', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      rows: [
        { elements: [{ status: 'OK', duration: 100, distance: 900 }] },
        { elements: [{ status: 'OK', duration: 100, distance: 800 }] },
        { elements: [{ status: 'OK', duration: 100, distance: 800 }] },
        { elements: [{ status: 'OK', duration: 200, distance: 100 }] },
      ],
    }) }) }),
  });
  assert.equal((await service.triggerDispatch('job')).driverId, 'b');
  assert.deepEqual(db.read('jobs/job/dispatch_runs', '1').candidates.map(c => c.driverId), ['b', 'c', 'a', 'driver']);
});
test('finite rounds deduplicate and respect both candidate limits', async () => {
  const { db, service } = setup();
  for (let i = 0; i < 50; i++) db.seed('drivers', 'd' + String(i).padStart(2, '0'), driver(T, nowMs));
  await service.triggerDispatch('job');
  const run = db.read('jobs/job/dispatch_runs', '1');
  assert.equal(run.candidates.length, 30);
  assert.equal(new Set(run.candidates.map(c => c.driverId)).size, 30);
  assert.deepEqual([0, 1, 2].map(r => run.candidates.filter(c => c.roundIndex === r).length), [10, 10, 10]);
});
test('deterministic canonical tuple fixes underscore collision and generation separation', () => {
  assert.notEqual(offerIdFor('a_b', 'c', 1), offerIdFor('a', 'b_c', 1));
  assert.equal(offerIdFor('a_b', 'c', 1), offerIdFor('a_b', 'c', 1));
  assert.notEqual(offerIdFor('a', 'b', 1), offerIdFor('a', 'b', 2));
});

const badConfigs = [
  ['version', 0], ['version', '1'], ['version', Number.MAX_SAFE_INTEGER + 1],
  ['locationFreshnessSeconds', NaN], ['locationFreshnessSeconds', Infinity], ['locationFreshnessSeconds', -1],
  ['radiusKmSequence', []], ['radiusKmSequence', [0]], ['radiusKmSequence', [10, 10]], ['radiusKmSequence', [20, 10]],
  ['radiusKmSequence', [NaN]], ['radiusKmSequence', [Infinity]], ['radiusKmSequence', ['10']],
  ['maxUniqueCandidatesPerGeneration', 31], ['maxUniqueCandidatesPerGeneration', 0],
  ['maxMatrixShortlistPerRound', 11], ['maxMatrixShortlistPerRound', -1],
  ['rankingPrimary', 'distance'], ['rankingSecondary', 'eta'], ['rankingTieBreak', 'random'],
  ['olaFailureMode', 'ignore'], ['olaMonthlyPairCap', undefined], ['olaMonthlyPairCap', 0],
  ['olaMonthlyPairCap', -1], ['olaMonthlyPairCap', Infinity], ['olaMonthlyPairCap', '100'], ['updatedAt', null],
];
for (const [field, value] of badConfigs) test('config rejects ' + field + '=' + String(value), () => {
  assert.throws(() => validateDispatchConfig(config(T, nowMs, { [field]: value })), { code: 'CONFIG_INVALID' });
});
test('shortlist cannot exceed unique candidate limit', () => {
  assert.throws(() => validateDispatchConfig(config(T, nowMs, { maxUniqueCandidatesPerGeneration: 5 })), { code: 'CONFIG_INVALID' });
});
const badJobs = [
  { requestedTruckType: 'hydraulic' }, { pickupCoords: { lat: '18', lng: 73 } },
  { pickupCoords: { lat: 91, lng: 73 } }, { destCoords: { lat: 18, lng: Infinity } },
  { bookingFeePaise: NaN }, { bookingFeePaise: -1 }, { driverCommissionPaise: '5000' },
  { driverCommissionPaise: Infinity }, { estimatedFarePaise: 0.5 }, { estimatedFarePaise: Number.MAX_SAFE_INTEGER + 1 },
  { razorpayPaymentId: null }, { razorpayPaymentLinkId: '' }, { paymentConfirmedAt: 'today' },
  { assignedDriver: 'driver' }, { offeredTo: 'driver' }, { currentOfferId: 'offer' },
  { dispatchGeneration: '1' }, { dispatchGeneration: 1, dispatchRunId: 'wrong' },
  { stateVersion: Number.MAX_SAFE_INTEGER }, { dispatchLeaseOwner: 'owner' },
  { cancellationRequestedAt: T.fromMillis(nowMs) }, { cancelledBy: 'driver' }, { cancellationResolutionState: 'pending' },
  { refundedAmountPaise: 10000 }, { refundState: 'confirmed' },
];
for (const [i, patch] of badJobs.entries()) test('critical paid-job validation rejects case ' + i, async () => {
  const { db, service } = setup();
  const job = paidJob(T, nowMs, patch);
  db.seed('jobs', 'job', job);
  assert.throws(() => validatePaidJob(materializeWorkflow(job).job));
  const result = await service.triggerDispatch('job');
  assert.equal(result.dispatched, false);
  assert.deepEqual(db.read('jobs', 'job'), job);
  assert.equal(db.read('jobs/job/dispatch_runs', '1'), undefined);
});
test('invalid configuration never cancels the paid job', async () => {
  const { db, service } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { radiusKmSequence: [NaN] }));
  const result = await service.triggerDispatch('job');
  assert.equal(result.state, 'operational_hold');
  assert.equal(db.read('jobs', 'job').status, 'pending_offer');
});
test('bounded transient provider retries degrade after all attempts', async () => {
  const { db } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: 100 }));
  let calls = 0;
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs),
    olaClient: createOlaMapsClient({ apiKey: 'test', backoffMs: 0,
      fetchImpl: async () => { calls++; return { ok: false, status: 503 }; } }),
  });
  assert.equal((await service.triggerDispatch('job')).dispatched, true);
  assert.equal(calls, 3);
  assert.equal(db.read('jobs/job/dispatch_runs', '1').candidates[0].rankingMode, 'haversine_degraded');
  assert.equal(db.read('usage_counters', '2026-09').olaMapsMatrixRequests, 3);
});
for (const status of [400, 401, 403]) test('HTTP ' + status + ' fails closed without exhaustion', async () => {
  const { db } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: 100 }));
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs),
    olaClient: createOlaMapsClient({ apiKey: 'test', fetchImpl: async () => ({ ok: false, status }) }),
  });
  assert.equal((await service.triggerDispatch('job')).state, 'operational_hold');
  assert.equal(db.read('jobs/job/dispatch_runs', '1'), undefined);
});
test('unknown failures persist bounded code only, never arbitrary details', async () => {
  const { db } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: 100 }));
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs),
    olaClient: { getDistanceMatrix: async () => { throw Object.assign(new Error('private response'), { code: { token: 'secret' } }); } },
  });
  assert.equal((await service.triggerDispatch('job')).state, 'operational_hold');
  const failure = db.read('jobs', 'job').dispatchLastFailure;
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'occurredAt', 'retryable', 'source']);
  assert.equal(failure.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(failure).includes('secret'), false);
});
test('malformed response cannot leave an empty run that causes no-driver', async () => {
  const { db } = setup();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: 100 }));
  const service = createDispatchService({ db, TimestampClass: T, now: () => new Date(nowMs),
    olaClient: createOlaMapsClient({ apiKey: 'test', fetchImpl: async () => ({ ok: true, status: 200, json: async () => matrixBody(0) }) }),
  });
  assert.equal((await service.triggerDispatch('job')).state, 'operational_hold');
  assert.equal(db.read('jobs/job/dispatch_runs', '1'), undefined);
});
