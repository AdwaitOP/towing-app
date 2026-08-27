'use strict';

const { FakeFirestore, FakeTimestamp, limitations } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createIdempotencyService,
  OwnershipLostError,
} = require('../../../firebase/functions/src/utils/idempotency');

test('a stale owner cannot complete or delete a lease after reclaim', async () => {
  const db = new FakeFirestore();
  let now = 1000;
  const tokens = ['old-owner', 'new-owner'];
  const service = createIdempotencyService({
    db, TimestampClass: FakeTimestamp, now: () => now, randomUUID: () => tokens.shift(), leaseMs: 100,
  });
  const oldClaim = await service.claimLease('meta:wamid1', 'whatsapp_message');
  now = 1200;
  const newClaim = await service.claimLease('meta:wamid1', 'whatsapp_message');
  await assert.rejects(service.markCompleted('meta:wamid1', oldClaim.ownerToken), OwnershipLostError);
  assert.equal(await service.markFailed('meta:wamid1', oldClaim.ownerToken), false);
  assert.equal(db.read('processed_requests', 'meta:wamid1').ownerToken, newClaim.ownerToken);
  assert.equal(await service.markCompleted('meta:wamid1', newClaim.ownerToken), true);
  assert.equal(db.read('processed_requests', 'meta:wamid1').status, 'completed');
});

test('active leases are retryable and completed requests do not rerun work', async () => {
  const db = new FakeFirestore();
  let now = 1000;
  let token = 0;
  const service = createIdempotencyService({
    db, TimestampClass: FakeTimestamp, now: () => now, randomUUID: () => `owner-${++token}`, leaseMs: 100,
  });
  await service.claimLease('request-1', 'test');
  const active = await service.executeIdempotent('request-1', 'test', async () => assert.fail('must not run'));
  assert.equal(active.status, 503);
  now = 1200;
  let operations = 0;
  const completed = await service.executeIdempotent('request-1', 'test', async () => { operations += 1; });
  assert.equal(completed.status, 200);
  const duplicate = await service.executeIdempotent('request-1', 'test', async () => { operations += 1; });
  assert.equal(duplicate.message, 'Already processed');
  assert.equal(operations, 1);
});

test('failed operations release only their own lease for retry', async () => {
  const db = new FakeFirestore();
  const service = createIdempotencyService({
    db, TimestampClass: FakeTimestamp, now: () => 1000, randomUUID: () => 'owned', leaseMs: 100,
  });
  await assert.rejects(service.executeIdempotent('request-2', 'test', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(db.read('processed_requests', 'request-2'), undefined);
});

test('cross-type and malformed idempotency records fail closed', async () => {
  const db = new FakeFirestore();
  const service = createIdempotencyService({
    db, TimestampClass: FakeTimestamp, now: () => 1000, randomUUID: () => 'owner', leaseMs: 100,
  });
  db.seed('processed_requests', 'collision', {
    type: 'razorpay_webhook', status: 'completed', processedAt: FakeTimestamp.fromMillis(900),
  });
  await assert.rejects(service.claimLease('collision', 'whatsapp_message'), /another request type/);
  db.seed('processed_requests', 'malformed', { type: 'test', status: 'completed' });
  await assert.rejects(service.claimLease('malformed', 'test'), /malformed/);
  db.seed('processed_requests', 'bad-lease', {
    type: 'test', status: 'in_progress', ownerToken: '', leaseUntil: null,
  });
  await assert.rejects(service.claimLease('bad-lease', 'test'), /malformed/);
});

test('unit fake declares why it is not concurrency evidence', () => {
  assert.deepEqual(limitations, [
    'Transactions are serialized rather than conflicted and retried.',
    'There is no cross-process isolation or crash model.',
    'Provider and Storage behavior must be injected explicitly.',
  ]);
});
