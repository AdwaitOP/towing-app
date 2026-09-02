'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T, GeoPoint, FieldValue } = require('firebase-admin/firestore');
const { createDispatchService, offerIdFor } = require('../../../firebase/functions/src/dispatch/dispatchService');
const { createDispatchRecovery } = require('../../../firebase/functions/src/dispatch/dispatchRecovery');
const { createDispatchBoundary } = require('../../../firebase/functions/src/jobs/dispatchBoundary');
const { createUsageCounterService } = require('../../../firebase/functions/src/services/usageCounterService');
const { createOlaMapsClient } = require('../../../firebase/functions/src/services/olaMapsClient');
const { createRazorpayWebhook } = require('../../../firebase/functions/src/payments/razorpayWebhook');
const { materializeWorkflow, validatePaidJob } = require('../../../firebase/functions/src/dispatch/dispatchValidation');
const { paidJob, config, driver, matrixBody } = require('../fixtures');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) throw new Error('A loopback Firestore Emulator is mandatory');
const project = 'towing-stage2-repair-dispatch';
const app = initializeApp({ projectId: project }, 'stage2-repair-tests');
const db = getFirestore(app);
let clock;
const now = () => new Date(clock);
const jobRef = id => db.doc('jobs/' + id);
const runRef = id => db.doc('jobs/' + id + '/dispatch_runs/1');
const read = async ref => (await ref.get()).data();
const service = (options = {}) => createDispatchService({ db, now, ...options });
const usage = () => createUsageCounterService({ db, now });
const counterRef = () => db.doc('usage_counters/2026-09');
const counter = overrides => ({ olaMapsMatrixRequests: 1, olaMapsMatrixPairs: 1,
  whatsappTemplateSends: 0, softCapWhatsapp: 900, updatedAt: T.fromMillis(clock), ...overrides });

test.beforeEach(async () => {
  clock = Date.parse('2026-09-02T10:00:00Z');
  const response = await fetch('http://' + host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
  assert.equal(response.ok, true);
  await db.doc('dispatch_config/main').set(config(T, clock));
});
test.after(async () => { await db.terminate(); await app.delete(); });

async function seedJob(id = 'job', patch = {}) {
  const job = paidJob(T, clock, patch);
  await jobRef(id).set(job);
  validatePaidJob(materializeWorkflow(paidJob(T, clock)).job); // Known-valid baseline.
  return job;
}
async function seedDriver(id = 'driver', patch = {}) {
  await db.doc('drivers/' + id).set(driver(T, clock, { location: new GeoPoint(18.525, 73.86), ...patch }));
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
// Delays only entry to one REAL Admin SDK transaction. The callback, reads,
// conflicts, retries, locks, and commit are always executed by Firestore.
function gatedDb(transactionNumber) {
  const reached = deferred(), release = deferred();
  let count = 0;
  return {
    reached: reached.promise, release: release.resolve,
    db: { collection: path => db.collection(path), runTransaction: async callback => {
      if (++count === transactionNumber) { reached.resolve(); await release.promise; }
      return db.runTransaction(callback);
    } },
  };
}
async function pausedPublication({ empty = false } = {}) {
  await seedJob();
  if (!empty) await seedDriver();
  const gate = gatedDb(4); // claim, selecting, create run, publish/exhaust
  const worker = service({ db: gate.db }).processDispatchJob('job', { ownerToken: 'worker_A', leaseDurationMs: 1000 });
  await gate.reached;
  return { gate, worker };
}

test('paid pending_offer recovers with ZERO boundary/trigger invocations after process restart', async () => {
  await seedDriver();
  await seedJob('job', { status: 'awaiting_payment', razorpayPaymentId: null, paymentConfirmedAt: null });
  const webhook = createRazorpayWebhook({ db, now: () => clock,
    invoice: { ensureInvoiceAndSend: async () => ({ sent: true }) },
    dispatch: { triggerDispatch: async () => ({ missed: true }) },
  });
  await webhook.processPayment({ jobId: 'job', paymentLinkId: 'plink_TEST', paymentId: 'pay_TEST', amountPaise: 10000 });
  const before = await read(jobRef('job'));
  assert.equal(before.status, 'pending_offer');
  assert.equal(before.dispatchState, undefined);
  // Fresh service instance models process restart; no in-memory dispatch queue.
  const result = await createDispatchRecovery({ db, service: service(), batchSize: 1 }).reconcilePendingJobs();
  assert.equal(result.offered, 1);
  assert.equal((await read(jobRef('job'))).status, 'offered');
  assert.equal((await runRef('job').get()).exists, true);
});

test('production exports register both Firestore consumer and scheduled recovery', () => {
  const functions = require('../../../firebase/functions/src/index');
  assert.equal(functions.dispatchPendingJob.__endpoint.eventTrigger.eventType, 'google.cloud.firestore.document.v1.written');
  assert.ok(functions.reconcilePendingDispatch.__endpoint.scheduleTrigger);
  assert.equal(typeof functions.reconcilePendingDispatch.run, 'function');
});

test('Firestore consumer handles payment transition and ignores its own selecting writes', async () => {
  await seedJob(); await seedDriver();
  const recovery = createDispatchRecovery({ db, service: service() });
  const after = await jobRef('job').get();
  const result = await recovery.consumePendingJob({ params: { jobId: 'job' },
    data: { before: { exists: true, data: () => ({ status: 'awaiting_payment' }) }, after } });
  assert.equal(result.dispatched, true);
  const ignored = await recovery.consumePendingJob({ params: { jobId: 'job' }, data: {
    before: { exists: true, data: () => ({ status: 'pending_offer', dispatchState: 'claimed' }) },
    after: { exists: true, data: () => ({ status: 'pending_offer', dispatchState: 'selecting' }) },
  } });
  assert.equal(ignored, undefined);
});

test('status-only scan pages past held/not-due jobs and resumes due retry_wait', async () => {
  for (const id of ['a_hold', 'b_future', 'c_due']) {
    const base = materializeWorkflow(paidJob(T, clock)).job;
    await seedJob(id, { ...base, dispatchState: id === 'a_hold' ? 'operational_hold' : 'retry_wait',
      dispatchNextActionAt: id === 'a_hold' ? null : T.fromMillis(clock + (id === 'b_future' ? 60000 : -1)) });
  }
  await seedDriver();
  const result = await createDispatchRecovery({ db, service: service(), batchSize: 1 }).reconcilePendingJobs();
  assert.equal(result.discovered, 3);
  assert.equal(result.offered, 1);
  assert.equal((await read(jobRef('c_due'))).status, 'offered');
  assert.equal((await read(jobRef('b_future'))).dispatchState, 'retry_wait');
});
test('real transient failure persists retry_wait, a fresh recovery consumer resumes it', async () => {
  await seedJob(); await seedDriver();
  let calls = 0;
  const adapter = { collection: path => db.collection(path), runTransaction: callback => {
    if (++calls === 3) throw Object.assign(new Error('transport unavailable'), { code: 14 });
    return db.runTransaction(callback);
  } };
  assert.equal((await service({ db: adapter }).processDispatchJob('job')).state, 'retry_wait');
  assert.equal((await read(jobRef('job'))).dispatchLastFailure.code, 'INFRASTRUCTURE_UNAVAILABLE');
  clock += 15001;
  assert.equal((await createDispatchRecovery({ db, service: service() }).reconcilePendingJobs()).offered, 1);
});

test('concurrent legacy bootstrap claims once and preserves payment/pricing/invoice evidence', async () => {
  const original = await seedJob('job', {
    invoiceNumber: 'TDS-0123', invoiceUrl: 'https://private.invalid/invoice', invoiceStoragePath: 'invoices/job.pdf',
    invoiceIssueDateIst: '2026-09-02', invoiceIssuedAt: T.fromMillis(clock - 500), invoiceSentAt: T.fromMillis(clock - 100),
    invoiceWhatsAppMessageId: 'wamid_private', requestId: null, forfeitedAmount: 0,
  });
  const claims = await Promise.all(['A', 'B', 'C', 'D'].map(owner => service().claimDispatch('job', owner)));
  assert.equal(claims.filter(result => result.claimed).length, 1);
  const after = await read(jobRef('job'));
  for (const [key, value] of Object.entries(original)) if (key !== 'updatedAt') assert.deepEqual(after[key], value, key);
  assert.equal(after.dispatchGeneration, 0);
  assert.equal(after.refundState, 'none');
});
for (const patch of [
  { cancellationRequestedAt: T.fromMillis(1788343199000) },
  { cancellationResolvedAt: T.fromMillis(1788343199000), cancellationResolutionState: 'resolved' },
  { cancelledAt: T.fromMillis(1788343199000), cancelledBy: 'customer', cancellationReason: 'customer_requested' },
  { refundRequestId: 'job', refundState: 'confirmed', razorpayRefundId: 'rfnd_TEST',
    refundedAmountPaise: 10000, refundConfirmedAt: T.fromMillis(1788343199000) },
]) test('bootstrap fails closed and preserves existing historical markers: ' + Object.keys(patch).join(','), async () => {
  await seedJob('job', { ...patch, invoiceNumber: 'TDS-HISTORY', razorpayPaymentId: 'pay_HISTORY' });
  const original = await read(jobRef('job'));
  assert.equal((await service().bootstrapDispatchJob('job')).ready, false);
  assert.equal((await service().claimDispatch('job', 'owner')).claimed, false);
  assert.deepEqual(await read(jobRef('job')), original);
});

for (const reclaim of [false, true]) test('lease expiry blocks paused publication ' + (reclaim ? 'AFTER reclaim' : 'BEFORE any reclaim'), async () => {
  const { gate, worker } = await pausedPublication();
  clock += 1001;
  if (reclaim) {
    const winner = await service().processDispatchJob('job', { ownerToken: 'worker_B' });
    assert.equal(winner.dispatched, true);
  }
  const jobBefore = await read(jobRef('job')), runBefore = await read(runRef('job'));
  gate.release();
  const result = await worker;
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, reclaim ? 'LEASE_DISPLACED' : 'LEASE_EXPIRED');
  assert.deepEqual(await read(jobRef('job')), jobBefore);
  assert.deepEqual(await read(runRef('job')), runBefore);
  assert.equal((await db.collection('job_offers').get()).size, reclaim ? 1 : 0);
});
test('lease expiry during ranking denies run creation itself', async () => {
  await seedJob(); await seedDriver();
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  const client = createOlaMapsClient({ apiKey: 'test', fetchImpl: async () => {
    clock += 1001; return { ok: true, status: 200, json: async () => matrixBody() };
  } });
  assert.equal((await service({ olaClient: client }).processDispatchJob('job', { leaseDurationMs: 1000 })).reason, 'LEASE_EXPIRED');
  assert.equal((await runRef('job').get()).exists, false);
  assert.equal((await db.collection('job_offers').get()).empty, true);
});
test('lease expiry revokes subsequent Ola retry reservations and HTTP authority', async () => {
  await seedJob(); await seedDriver();
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  let calls = 0;
  const client = createOlaMapsClient({ apiKey: 'test', backoffMs: 0, fetchImpl: async () => {
    calls++; clock += 1001; return { ok: false, status: 429 };
  } });
  assert.equal((await service({ olaClient: client }).processDispatchJob('job', { leaseDurationMs: 1000 })).reason, 'LEASE_EXPIRED');
  assert.equal(calls, 1);
  assert.equal((await read(counterRef())).olaMapsMatrixRequests, 1);
  assert.equal((await runRef('job').get()).exists, false);
});
test('claim time is recomputed when the real Firestore transaction runner retries callback', async () => {
  await seedJob();
  let attempts = 0;
  const adapter = { collection: path => db.collection(path),
    runTransaction: callback => db.runTransaction(async tx => {
      const result = await callback(tx);
      if (++attempts === 1) { clock += 2000; throw Object.assign(new Error('injected ABORTED'), { code: 10 }); }
      return result;
    }),
  };
  const result = await service({ db: adapter }).claimDispatch('job', 'owner', 1000);
  assert.equal(result.claimed, true);
  assert.ok(attempts >= 2);
  assert.equal((await read(jobRef('job'))).dispatchLeaseUntil.toMillis(), clock + 1000);
});
test('expired lease cannot move selecting state', async () => {
  await seedJob();
  const gate = gatedDb(2);
  const worker = service({ db: gate.db }).processDispatchJob('job', { leaseDurationMs: 1000 });
  await gate.reached; clock += 1001;
  const before = await read(jobRef('job'));
  gate.release();
  assert.equal((await worker).reason, 'LEASE_EXPIRED');
  assert.deepEqual(await read(jobRef('job')), before);
});
test('expired lease cannot persist a failure/hold or clear ownership', async () => {
  await seedJob(); await seedDriver();
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  const client = { getDistanceMatrix: async () => { clock += 1001; throw Object.assign(new Error(), { code: 14 }); } };
  assert.equal((await service({ olaClient: client }).processDispatchJob('job', { leaseDurationMs: 1000 })).reason, 'LEASE_EXPIRED');
  const job = await read(jobRef('job'));
  assert.equal(job.dispatchState, 'selecting'); assert.notEqual(job.dispatchLeaseOwner, null);
  assert.equal(job.dispatchLastFailure, null);
});
for (const empty of [true, false]) test('lease expiry prevents ' + (empty ? 'terminal exhaustion' : 'candidate skip/cursor advancement'), async () => {
  const { gate, worker } = await pausedPublication({ empty });
  if (!empty) await db.doc('drivers/driver').update({ isOnDuty: false });
  clock += 1001;
  const before = await read(runRef('job'));
  gate.release();
  assert.equal((await worker).reason, 'LEASE_EXPIRED');
  assert.deepEqual(await read(runRef('job')), before);
  assert.equal((await db.collection('refund_requests').get()).empty, true);
});
test('publication transaction callback retry rechecks expiry before any writes', async () => {
  await seedJob(); await seedDriver();
  let txCount = 0, publicationAttempts = 0;
  const adapter = { collection: path => db.collection(path), runTransaction: callback => {
    const publication = ++txCount === 4;
    return db.runTransaction(async tx => {
      const result = await callback(tx);
      if (publication && ++publicationAttempts === 1) {
        clock += 1001;
        throw Object.assign(new Error('injected commit conflict'), { code: 10 });
      }
      return result;
    });
  } };
  assert.equal((await service({ db: adapter }).processDispatchJob('job', { leaseDurationMs: 1000 })).reason, 'LEASE_EXPIRED');
  assert.equal((await read(runRef('job'))).nextCandidateIndex, 0);
  assert.equal((await db.collection('job_offers').get()).empty, true);
  assert.equal((await read(db.doc('drivers/driver'))).activeOfferId, null);
});
test('existing same-generation run is never overwritten or replaced', async () => {
  await seedJob();
  const original = { generation: 1, immutableEvidence: 'already exists' };
  await runRef('job').set(original);
  assert.equal((await service().processDispatchJob('job')).state, 'operational_hold');
  assert.deepEqual(await read(runRef('job')), original);
  assert.equal((await jobRef('job').collection('dispatch_runs').get()).size, 1);
});
for (const patch of [{ assignedDriver: 'unexpected' }, { estimatedFarePaise: '45000' }, { currentOfferId: 'unexpected' }]) {
  test('publication revalidates changed critical job data: ' + Object.keys(patch)[0], async () => {
    const { gate, worker } = await pausedPublication();
    await jobRef('job').update(patch);
    gate.release();
    // No valid owner can repair malformed history merely by writing defaults.
    assert.equal((await worker).dispatched, false);
    assert.equal((await db.collection('job_offers').get()).empty, true);
    assert.equal((await read(runRef('job'))).nextCandidateIndex, 0);
  });
}
test('duplicate semantic triggers create one nested generation and one atomic offer', async () => {
  await seedJob(); await seedDriver();
  const results = await Promise.all(Array.from({ length: 5 }, () => service().processDispatchJob('job')));
  assert.equal(results.filter(r => r.dispatched).length, 1);
  const job = await read(jobRef('job')), run = await read(runRef('job'));
  assert.equal(job.dispatchRunId, '1'); assert.equal(run.generation, 1);
  assert.equal((await jobRef('job').collection('dispatch_runs').get()).size, 1);
  assert.equal((await db.collection('dispatch_runs').get()).size, 0);
  const offer = await read(db.doc('job_offers/' + job.currentOfferId));
  assert.equal(Object.keys(offer).length, 26);
  assert.equal(offer.expiresAt.toMillis() - offer.offeredAt.toMillis(), 45000);
  assert.equal(run.currentOfferId, job.currentOfferId);
  assert.equal((await read(db.doc('drivers/driver'))).activeOfferId, job.currentOfferId);
  const before = { job, run, offer };
  assert.equal((await service().processDispatchJob('job')).dispatched, false);
  assert.deepEqual({ job: await read(jobRef('job')), run: await read(runRef('job')),
    offer: await read(db.doc('job_offers/' + job.currentOfferId)) }, before);
});
test('two jobs contend for driver activeOfferId: only one offer can publish', async () => {
  await seedJob('one'); await seedJob('two'); await seedDriver();
  const results = await Promise.all(['one', 'two'].map(id => service().processDispatchJob(id)));
  assert.equal(results.filter(r => r.dispatched).length, 1);
  assert.equal((await db.collection('job_offers').get()).size, 1);
  const offer = (await db.collection('job_offers').get()).docs[0];
  assert.equal((await read(db.doc('drivers/driver'))).activeOfferId, offer.id);
});
const driverChanges = [
  ['location map instead of GeoPoint', { location: { latitude: 18.525, longitude: 73.86 } }],
  ['location removed', { location: FieldValue.delete() }], ['location stale', { locationUpdatedAt: T.fromMillis(1788342800000) }],
  ['location future', { locationUpdatedAt: T.fromMillis(1788343260000) }], ['timestamp removed', { locationUpdatedAt: FieldValue.delete() }],
  ['malformed ban', { bannedUntil: 'yesterday' }], ['ban removed', { bannedUntil: FieldValue.delete() }],
  ['engagement missing', { activeOfferId: FieldValue.delete() }], ['engagement false', { activeJobId: false }],
  ['wallet NaN', { walletBalance: NaN }], ['off duty', { isOnDuty: false }], ['not approved', { verificationStatus: 'pending' }],
  ['capability revoked', { canFlatbed: false }], ['ban active', { bannedUntil: T.fromMillis(1788343260000) }],
  ['wallet insufficient', { walletBalance: 1 }], ['active job', { activeJobId: 'another' }], ['active offer', { activeOfferId: 'another' }],
];
for (const [label, patch] of driverChanges) test('publication rechecks ' + label + ' inside transaction', async () => {
  const { gate, worker } = await pausedPublication();
  await db.doc('drivers/driver').update(patch);
  gate.release();
  const result = await worker;
  assert.equal(result.dispatched, false);
  assert.equal((await db.collection('job_offers').get()).empty, true);
  assert.notEqual((await read(jobRef('job'))).status, 'offered');
});
for (const terminal of [false, true]) test('customer cancellation first prevents ' + (terminal ? 'exhaustion' : 'offer publication'), async () => {
  const { gate, worker } = await pausedPublication({ empty: terminal });
  await jobRef('job').update(terminal ? { status: 'cancelled_customer', cancelledBy: 'customer',
    cancellationReason: 'customer_requested', cancellationRequestedAt: T.fromMillis(clock) } :
    { cancellationRequestedAt: T.fromMillis(clock), cancellationResolutionState: 'pending' });
  const before = await read(jobRef('job')), runBefore = await read(runRef('job'));
  gate.release();
  assert.equal((await worker).dispatched, false);
  assert.deepEqual(await read(jobRef('job')), before);
  assert.deepEqual(await read(runRef('job')), runBefore);
  assert.equal((await db.collection('refund_requests').get()).empty, true);
  assert.equal((await db.collection('job_offers').get()).empty, true);
});
test('customer marker alone prevents stale no-driver exhaustion while still pending_offer', async () => {
  const { gate, worker } = await pausedPublication({ empty: true });
  await jobRef('job').update({ cancellationRequestedAt: T.fromMillis(clock) });
  gate.release();
  assert.equal((await worker).reason, 'CANCELLATION_PRECEDENCE');
  assert.equal((await read(jobRef('job'))).status, 'pending_offer');
  assert.equal((await db.collection('refund_requests').get()).empty, true);
});
for (const patch of [
  { nextCandidateIndex: 10 }, { candidates: [], nextCandidateIndex: 1 },
  { attemptedDriverIds: ['fabricated'] }, { status: 'exhausted' }, { generation: 2 },
]) test('corrupted run cannot prove exhaustion: ' + Object.keys(patch).join(','), async () => {
  const { gate, worker } = await pausedPublication();
  await runRef('job').update(patch);
  gate.release();
  assert.equal((await worker).state, 'operational_hold');
  assert.equal((await read(jobRef('job'))).status, 'pending_offer');
  assert.equal((await db.collection('refund_requests').get()).empty, true);
});
test('genuine empty finite search atomically commits no-driver cancellation and exact refund intent', async () => {
  await seedJob();
  const results = await Promise.all([service().processDispatchJob('job'), service().processDispatchJob('job')]);
  assert.equal(results.filter(r => r.exhausted).length, 1);
  const [job, run, refund] = await db.runTransaction(async tx => {
    const a = await tx.get(jobRef('job')), b = await tx.get(runRef('job')), c = await tx.get(db.doc('refund_requests/job'));
    return [a.data(), b.data(), c.data()];
  });
  assert.equal(job.status, 'cancelled_system'); assert.equal(job.cancelledBy, 'system');
  assert.equal(job.cancellationReason, 'no_driver_found'); assert.equal(run.status, 'exhausted');
  assert.equal(job.refundRequestId, 'job'); assert.equal(job.refundState, 'pending');
  assert.equal(refund.amountPaise, job.bookingFeePaise); assert.equal(refund.razorpayPaymentId, job.razorpayPaymentId);
  assert.equal(refund.operationId, 'job'); assert.equal(refund.state, 'pending');
  assert.equal(refund.providerIdempotencyKey, 'refund_no_driver_found_job');
  assert.equal(refund.providerRequestHash, createHash('sha256').update(JSON.stringify({ paymentId: 'pay_TEST', amount: 10000 })).digest('hex'));
  assert.deepEqual(refund.nextAttemptAt, job.refundNextAttemptAt);
  assert.deepEqual(refund.createdAt, job.cancelledAt); assert.deepEqual(run.finalizedAt, job.cancelledAt);
  const schema = require('../../../firebase/seed/refund_requests_schema.json');
  assert.deepEqual(Object.keys(refund).sort(), Object.keys(schema).filter(k => !k.startsWith('_')).sort());
});
test('conflicting refund document aborts terminal job/run writes atomically', async () => {
  const { gate, worker } = await pausedPublication({ empty: true });
  await db.doc('refund_requests/job').set({ paymentId: 'unrelated' });
  gate.release();
  assert.equal((await worker).state, 'operational_hold');
  assert.equal((await read(jobRef('job'))).status, 'pending_offer');
  assert.equal((await read(runRef('job'))).status, 'active');
  assert.deepEqual(await read(db.doc('refund_requests/job')), { paymentId: 'unrelated' });
});
test('concurrent near-cap reservations serialize against current config and counters', async () => {
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 10 });
  await counterRef().set(counter({ olaMapsMatrixPairs: 8 }));
  const results = await Promise.all([usage().reserveOlaMatrixUsage({ plannedPairs: 2 }), usage().reserveOlaMatrixUsage({ plannedPairs: 2 })]);
  assert.equal(results.filter(r => r.authorized).length, 1);
  const after = await read(counterRef());
  assert.equal(after.olaMapsMatrixPairs, 10); assert.equal(after.olaMapsMatrixRequests, 2);
});
test('current cap 5 overrides previously observed caller cap 100 for a 10-pair attempt', async () => {
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  const stale = (await read(db.doc('dispatch_config/main'))).olaMonthlyPairCap;
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 5 });
  const result = await usage().reserveOlaMatrixUsage({ plannedPairs: 10, cap: stale });
  assert.equal(result.authorized, false); assert.equal(result.cap, 5);
  assert.equal((await counterRef().get()).exists, false);
});
for (const patch of [
  { olaMapsMatrixPairs: -1 }, { olaMapsMatrixRequests: -1 }, { olaMapsMatrixPairs: 'nine' },
  { olaMapsMatrixPairs: Number.MAX_SAFE_INTEGER + 1 }, { olaMapsMatrixPairs: 1.5 },
  { olaMapsMatrixRequests: Number.MAX_SAFE_INTEGER }, { olaMapsMatrixPairs: Number.MAX_SAFE_INTEGER },
  { whatsappTemplateSends: -1 }, { softCapWhatsapp: '900' },
]) test('persisted counter corruption/overflow is preserved and denied: ' + JSON.stringify(patch), async () => {
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: Number.MAX_SAFE_INTEGER });
  await counterRef().set(counter(patch));
  const before = await read(counterRef());
  await assert.rejects(() => usage().reserveOlaMatrixUsage({ plannedPairs: 2 }));
  assert.deepEqual(await read(counterRef()), before);
});
test('missing required counter structure is not silently bootstrapped', async () => {
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  await counterRef().set({ olaMapsMatrixPairs: 0 });
  await assert.rejects(() => usage().reserveOlaMatrixUsage({ plannedPairs: 1 }), { code: 'USAGE_COUNTER_INVALID' });
});
test('three actual HTTP attempts account for three requests and thirty pairs', async () => {
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  let calls = 0;
  const client = createOlaMapsClient({ apiKey: 'test', backoffMs: 0, fetchImpl: async () => {
    calls++; return calls < 3 ? { ok: false, status: calls === 1 ? 429 : 500 } :
      { ok: true, status: 200, json: async () => matrixBody(10) };
  } });
  await client.getDistanceMatrix({ origins: Array.from({ length: 10 }, () => ({ lat: 18, lng: 73 })),
    destinations: [{ lat: 18, lng: 73 }], authorizeAttempt: usage().reserveOlaMatrixUsage });
  const after = await read(counterRef());
  assert.equal(calls, 3); assert.equal(after.olaMapsMatrixRequests, 3); assert.equal(after.olaMapsMatrixPairs, 30);
});
test('cap lowered between HTTP attempts stops retries and dispatches in authorized degraded mode', async () => {
  await seedJob(); await seedDriver();
  await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 100 });
  let calls = 0;
  const client = createOlaMapsClient({ apiKey: 'test', backoffMs: 0, fetchImpl: async () => {
    calls++; await db.doc('dispatch_config/main').update({ olaMonthlyPairCap: 1 });
    return { ok: false, status: 429 };
  } });
  assert.equal((await service({ olaClient: client }).processDispatchJob('job')).dispatched, true);
  assert.equal(calls, 1); assert.equal((await read(counterRef())).olaMapsMatrixPairs, 1);
  assert.equal((await read(runRef('job'))).candidates[0].rankingMode, 'haversine_degraded');
});
test('collision pair publishes distinct deterministic offer documents', async () => {
  await seedJob('a_b'); await seedJob('a'); await seedDriver('c');
  const first = await service().processDispatchJob('a_b');
  await seedDriver('b_c');
  const second = await service().processDispatchJob('a');
  assert.equal(first.driverId, 'c'); assert.equal(second.driverId, 'b_c');
  assert.notEqual(first.offerId, second.offerId);
  assert.equal(first.offerId, offerIdFor('a_b', 'c', 1));
  assert.equal(second.offerId, offerIdFor('a', 'b_c', 1));
});
test('existing conflicting deterministic offer cannot be overwritten or partially projected', async () => {
  const { gate, worker } = await pausedPublication();
  const ref = db.doc('job_offers/' + offerIdFor('job', 'driver', 1));
  await ref.set({ jobId: 'another', driverId: 'driver', status: 'offered', immutableEvidence: 'preserve' });
  const before = await read(ref);
  gate.release();
  assert.equal((await worker).state, 'operational_hold');
  assert.deepEqual(await read(ref), before);
  assert.equal((await read(db.doc('drivers/driver'))).activeOfferId, null);
  assert.equal((await read(runRef('job'))).nextCandidateIndex, 0);
});
test('payment boundary acknowledges durable handoff without running driver search/Ola', async () => {
  await seedJob('job', { status: 'awaiting_payment', razorpayPaymentId: null, paymentConfirmedAt: null });
  const boundary = createDispatchBoundary({ handoff: service({ olaClient: {
    getDistanceMatrix: async () => { throw new Error('must not execute in webhook'); },
  } }).bootstrapDispatchJob });
  const webhook = createRazorpayWebhook({ db, now: () => clock, dispatch: boundary,
    invoice: { ensureInvoiceAndSend: async () => ({ sent: true }) } });
  await webhook.processPayment({ jobId: 'job', paymentLinkId: 'plink_TEST', paymentId: 'pay_TEST', amountPaise: 10000 });
  assert.equal((await read(jobRef('job'))).status, 'pending_offer');
  assert.equal((await runRef('job').get()).exists, false);
  assert.equal((await db.collection('job_offers').get()).empty, true);
});
test('failed handoff cannot reject payment; invoice failure retains Phase 3 retry behavior', async () => {
  await seedJob('job', { status: 'awaiting_payment', razorpayPaymentId: null, paymentConfirmedAt: null });
  let invoiceFails = true;
  const webhook = createRazorpayWebhook({ db, now: () => clock,
    dispatch: createDispatchBoundary({ handoff: async () => { throw new Error('dispatch unavailable'); } }),
    invoice: { ensureInvoiceAndSend: async () => { if (invoiceFails) throw new Error('invoice unavailable'); } } });
  const input = { jobId: 'job', paymentLinkId: 'plink_TEST', paymentId: 'pay_TEST', amountPaise: 10000 };
  await assert.rejects(() => webhook.processPayment(input), { code: 'PAYMENT_RECOVERY_INCOMPLETE' });
  assert.equal((await read(jobRef('job'))).razorpayPaymentId, 'pay_TEST');
  invoiceFails = false;
  await webhook.processPayment(input);
  assert.equal((await read(jobRef('job'))).status, 'pending_offer');
});
