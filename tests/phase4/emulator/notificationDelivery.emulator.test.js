'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp: T } = require('firebase-admin/firestore');
const {
  createNotificationDeliveryManager,
  validateCanonicalNotificationOutbox,
  renderNotificationMessage,
  EVENT_CONFIGS,
  LEASE_DURATION_MS,
} = require('../../../firebase/functions/src/dispatch/notificationDelivery');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(host || '')) {
  throw new Error('A loopback Firestore Emulator is mandatory');
}
const project = 'towing-stage10-notification-emulator';
const app = initializeApp({ projectId: project }, 'stage10-notification-emulator-tests');
const db = getFirestore(app);

let clock;
const now = () => new Date(clock);

test.beforeEach(async () => {
  clock = Date.parse('2026-09-02T10:00:00Z');
  const response = await fetch('http://' + host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', { method: 'DELETE' });
  assert.equal(response.ok, true);
});

test.after(async () => {
  await db.terminate();
  await app.delete();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function canonicalOutboxDoc(overrides = {}) {
  const at = T.fromMillis(clock);
  const eventType = overrides.eventType || 'job_accepted';
  const resourceType = eventType === 'refund_confirmed' ? 'refund_request' : 'job';
  const jobId = overrides.resourceId || overrides.payload?.jobId || 'job_100';
  const offerId = overrides.offerId || 'off_100';

  const defaultJobStatus = EVENT_CONFIGS[eventType]?.jobStatus || 'accepted';
  const defaultRefundAmountPaise = eventType === 'refund_confirmed' ? 10000 : null;

  const payload = {
    jobId,
    jobStatus: overrides.payload?.jobStatus || defaultJobStatus,
    refundAmountPaise: overrides.payload?.refundAmountPaise !== undefined ? overrides.payload.refundAmountPaise : defaultRefundAmountPaise,
  };

  const eventId = overrides.eventId || (eventType === 'job_accepted' ? `${eventType}:${jobId}:${offerId}` : `${eventType}:${jobId}`);

  return {
    eventId,
    eventType,
    recipientKey: overrides.recipientKey || `customer:${jobId}`,
    channel: 'whatsapp',
    resourceType: overrides.resourceType || resourceType,
    resourceId: jobId,
    payloadVersion: 1,
    payload,
    state: overrides.state || 'pending',
    attemptCount: overrides.attemptCount !== undefined ? overrides.attemptCount : 0,
    ownerToken: overrides.ownerToken !== undefined ? overrides.ownerToken : null,
    leaseUntil: overrides.leaseUntil !== undefined ? overrides.leaseUntil : null,
    nextAttemptAt: overrides.nextAttemptAt !== undefined ? overrides.nextAttemptAt : at,
    providerMessageId: overrides.providerMessageId !== undefined ? overrides.providerMessageId : null,
    lastErrorCode: overrides.lastErrorCode !== undefined ? overrides.lastErrorCode : null,
    sentAt: overrides.sentAt !== undefined ? overrides.sentAt : null,
    createdAt: overrides.createdAt || at,
    updatedAt: overrides.updatedAt || at,
    ...overrides,
  };
}

async function seedJob(jobId = 'job_100', overrides = {}) {
  const at = T.fromMillis(clock);
  const job = {
    customerPhone: '+919876543210',
    pickupCoords: { lat: 18.5204, lng: 73.8567 },
    destCoords: { lat: 18.55, lng: 73.88 },
    requestedTruckType: 'flatbed',
    distanceKm: 4.5,
    pricingTier: 1,
    bookingFeePaise: 10000,
    driverCommissionPaise: 5000,
    estimatedFarePaise: 45000,
    status: 'accepted',
    dispatchState: 'closed',
    offeredTo: null,
    assignedDriver: 'drv_1',
    channel: 'whatsapp',
    createdByAdmin: null,
    razorpayPaymentLinkId: 'plink_TEST',
    razorpayPaymentLinkUrl: 'https://rzp.io/i/test',
    razorpayPaymentId: 'pay_TEST123',
    paymentConfirmedAt: T.fromMillis(clock - 90000),
    invoiceNumber: null,
    invoiceUrl: null,
    invoiceSentAt: null,
    cancellationRequestedAt: null,
    cancellationResolvedAt: null,
    cancellationResolutionState: 'none',
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    refundRequestId: null,
    refundState: null,
    razorpayRefundId: null,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    refundNextAttemptAt: null,
    dispatchLeaseOwner: null,
    dispatchLeaseUntil: null,
    dispatchNextActionAt: null,
    dispatchLastFailure: null,
    stateVersion: 1,
    createdAt: T.fromMillis(clock - 120000),
    updatedAt: at,
    ...overrides,
  };
  await db.doc(`jobs/${jobId}`).set(job);
  return job;
}

async function seedRefundRequest(jobId = 'job_100', overrides = {}) {
  const at = T.fromMillis(clock);
  const paymentId = overrides.razorpayPaymentId || 'pay_TEST123';
  const amountPaise = overrides.amountPaise !== undefined ? overrides.amountPaise : 10000;
  const providerRequestHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId,
    amount: amountPaise,
  }), 'utf8').digest('hex');

  const refund = {
    operationId: jobId,
    jobId,
    razorpayPaymentId: paymentId,
    amountPaise,
    reason: 'no_driver_found',
    providerIdempotencyKey: 'refund_no_driver_found_' + jobId,
    providerRequestHash,
    state: 'confirmed',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    reconciliationNextAttemptAt: null,
    reconciliationAttempts: 1,
    razorpayRefundId: 'rfnd_CANONICAL123',
    confirmationSource: 'reconciliation',
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: T.fromMillis(clock - 70000),
    updatedAt: at,
    submittedAt: T.fromMillis(clock - 60000),
    confirmedAt: at,
    ...overrides,
  };
  await db.doc(`refund_requests/${jobId}`).set(refund);
  return refund;
}

async function seedOutbox(docData) {
  await db.doc(`notification_outbox/${docData.eventId}`).set(docData);
  return docData;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Concurrency: Two workers racing the same pending document
// ─────────────────────────────────────────────────────────────────────────────

test('E1. Concurrency: Two workers racing the same pending document — exactly one wins, one external call', async () => {
  await seedJob('job_race', { status: 'accepted' });
  const outboxDoc = canonicalOutboxDoc({
    eventId: 'job_accepted:job_race:off_100',
    eventType: 'job_accepted',
    resourceId: 'job_race',
  });
  await seedOutbox(outboxDoc);

  const inSendBarrier = deferred();
  const allowSendFinish = deferred();
  let sendCount = 0;

  const mockWhatsApp = {
    sendText: async () => {
      sendCount++;
      inSendBarrier.resolve();
      await allowSendFinish.promise;
      return { messageId: `msg_race_${sendCount}` };
    },
  };

  const worker1 = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  const worker2 = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  const p1 = worker1.deliverNotification(outboxDoc.eventId);
  const p2 = worker2.deliverNotification(outboxDoc.eventId);

  // Await until the winning worker acquires the claim transaction and enters sendText
  await inSendBarrier.promise;

  // The winning worker is now frozen at allowSendFinish.promise inside sendText.
  // The losing worker's transaction MUST complete and be rejected without waiting on sendText.
  const loserResult = await Promise.race([p1, p2]);
  assert.equal(loserResult.claimed, false);
  assert.equal(loserResult.status, 'in_progress', 'Losing worker must see active lease');

  // Now release the winner to complete sendText and finalize the transaction
  allowSendFinish.resolve();

  const [res1, res2] = await Promise.all([p1, p2]);

  // Exactly one worker must have successfully delivered
  const winners = [res1, res2].filter(r => r.claimed && r.status === 'sent');
  const nonWinners = [res1, res2].filter(r => !r.claimed || r.status !== 'sent');

  assert.equal(winners.length, 1, 'Exactly one worker must win the claim and send');
  assert.equal(nonWinners.length, 1, 'Non-winner must be skipped or fail claim');
  assert.equal(sendCount, 1, 'WhatsApp external sendText must be called exactly once');

  const finalDoc = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(finalDoc.state, 'sent');
  assert.equal(finalDoc.attemptCount, 1);
  assert.equal(finalDoc.providerMessageId, 'msg_race_1');
  assert.equal(finalDoc.ownerToken, null);
  assert.equal(finalDoc.leaseUntil, null);
  assert.ok(finalDoc.sentAt !== null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Lease reclamation and fencing:
//    Worker 1 paused after claim, lease expires, Worker 2 reclaims and finalizes,
//    Worker 1 stale finalizer rejected.
// ─────────────────────────────────────────────────────────────────────────────

test('E2. Fencing: Worker 1 paused after claim, Worker 2 reclaims upon lease expiry, Worker 1 stale finalizer rejected', async () => {
  await seedJob('job_fence', { status: 'accepted' });
  const outboxDoc = canonicalOutboxDoc({
    eventId: 'job_accepted:job_fence:off_100',
    eventType: 'job_accepted',
    resourceId: 'job_fence',
  });
  await seedOutbox(outboxDoc);

  const worker1SendStarted = deferred();
  const worker1CanFinish = deferred();
  let worker1SendAttempts = 0;
  let worker2SendAttempts = 0;

  const mockWhatsApp1 = {
    sendText: async () => {
      worker1SendAttempts++;
      worker1SendStarted.resolve();
      await worker1CanFinish.promise;
      return { messageId: 'msg_worker_1_stale' };
    },
  };

  const mockWhatsApp2 = {
    sendText: async () => {
      worker2SendAttempts++;
      return { messageId: 'msg_worker_2_winner' };
    },
  };

  const worker1 = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp1,
    TimestampClass: T,
    now,
    leaseDurationMs: 60000,
  });

  const worker2 = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp2,
    TimestampClass: T,
    now,
    leaseDurationMs: 60000,
  });

  // Launch worker 1 in background
  const worker1Promise = worker1.deliverNotification(outboxDoc.eventId);

  // Wait for worker 1 to have claimed the outbox doc and entered sendText
  await worker1SendStarted.promise;

  const inFlightDoc = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(inFlightDoc.state, 'in_progress');
  assert.equal(inFlightDoc.attemptCount, 1);
  const worker1OwnerToken = inFlightDoc.ownerToken;
  assert.ok(worker1OwnerToken);

  // Now simulate time advance beyond worker 1's 60s lease (clock + 65 seconds)
  clock += 65000;

  // Worker 2 now sweeps or processes the document
  const worker2Result = await worker2.deliverNotification(outboxDoc.eventId);
  assert.equal(worker2Result.claimed, true);
  assert.equal(worker2Result.status, 'sent');
  assert.equal(worker2SendAttempts, 1);

  // Verify Worker 2 has finalized the document to 'sent'
  const postWorker2Doc = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(postWorker2Doc.state, 'sent');
  assert.equal(postWorker2Doc.providerMessageId, 'msg_worker_2_winner');
  assert.equal(postWorker2Doc.attemptCount, 2);

  // Now unblock Worker 1 to attempt stale finalize
  worker1CanFinish.resolve();
  const worker1Result = await worker1Promise;

  // Worker 1's finalizer should detect terminal winner preservation or fencing
  assert.equal(worker1Result.claimed, true);
  assert.equal(worker1Result.status, 'sent');
  assert.equal(worker1Result.preserved, true);

  // Verify the document was NOT overwritten by Worker 1
  const finalDoc = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(finalDoc.state, 'sent');
  assert.equal(finalDoc.providerMessageId, 'msg_worker_2_winner', 'Worker 2 winner message ID must remain intact');
  assert.equal(finalDoc.attemptCount, 2);
  assert.equal(finalDoc.ownerToken, null);
  assert.equal(finalDoc.leaseUntil, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sweep discovery across composite indexes (state + nextAttemptAt, state + leaseUntil)
// ─────────────────────────────────────────────────────────────────────────────

test('E3. Sweeper: discovers due pending, due retry_wait, and expired in_progress via composite indexes', async () => {
  // Seed jobs for all test outbox documents
  await seedJob('job_due_pending', { status: 'in_progress' });
  await seedJob('job_due_retry', { status: 'in_progress' });
  await seedJob('job_expired_lease', { status: 'in_progress' });
  await seedJob('job_future_pending', { status: 'in_progress' });
  await seedJob('job_active_lease', { status: 'in_progress' });

  // 1. Due pending: state == 'pending' && nextAttemptAt <= now
  const docDuePending = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_due_pending',
    eventType: 'job_in_progress',
    resourceId: 'job_due_pending',
    state: 'pending',
    attemptCount: 0,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: T.fromMillis(clock - 5000),
  });
  await seedOutbox(docDuePending);

  // 2. Due retry_wait: state == 'retry_wait' && nextAttemptAt <= now
  const docDueRetry = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_due_retry',
    eventType: 'job_in_progress',
    resourceId: 'job_due_retry',
    state: 'retry_wait',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    lastErrorCode: 'provider_unavailable',
    nextAttemptAt: T.fromMillis(clock - 2000),
  });
  await seedOutbox(docDueRetry);

  // 3. Expired in_progress: state == 'in_progress' && leaseUntil <= now
  const docExpiredLease = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_expired_lease',
    eventType: 'job_in_progress',
    resourceId: 'job_expired_lease',
    state: 'in_progress',
    attemptCount: 1,
    ownerToken: 'dead_worker_token',
    leaseUntil: T.fromMillis(clock - 1000),
    nextAttemptAt: T.fromMillis(clock - 61000),
  });
  await seedOutbox(docExpiredLease);

  // 4. Future pending: state == 'pending' && nextAttemptAt > now (must NOT be swept)
  const docFuturePending = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_future_pending',
    eventType: 'job_in_progress',
    resourceId: 'job_future_pending',
    state: 'pending',
    attemptCount: 0,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: T.fromMillis(clock + 60000),
  });
  await seedOutbox(docFuturePending);

  // 5. Active in_progress: state == 'in_progress' && leaseUntil > now (must NOT be swept)
  const docActiveLease = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_active_lease',
    eventType: 'job_in_progress',
    resourceId: 'job_active_lease',
    state: 'in_progress',
    attemptCount: 1,
    ownerToken: 'live_worker_token',
    leaseUntil: T.fromMillis(clock + 60000),
    nextAttemptAt: T.fromMillis(clock),
  });
  await seedOutbox(docActiveLease);

  const sentMessages = [];
  const mockWhatsApp = {
    sendText: async (phone, text) => {
      sentMessages.push({ phone, text });
      return { messageId: `msg_sweep_${sentMessages.length}` };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  const sweepSummary = await manager.deliverPendingNotifications({ batchSize: 20 });

  assert.equal(sweepSummary.discovered, 3, 'Must discover exactly the 3 due/expired documents');
  assert.equal(sweepSummary.delivered, 3, 'Must deliver all 3 eligible documents');
  assert.equal(sentMessages.length, 3);

  // Verify due documents transitioned to 'sent'
  const snap1 = (await db.doc(`notification_outbox/${docDuePending.eventId}`).get()).data();
  assert.equal(snap1.state, 'sent');
  assert.equal(snap1.attemptCount, 1);

  const snap2 = (await db.doc(`notification_outbox/${docDueRetry.eventId}`).get()).data();
  assert.equal(snap2.state, 'sent');
  assert.equal(snap2.attemptCount, 2);

  const snap3 = (await db.doc(`notification_outbox/${docExpiredLease.eventId}`).get()).data();
  assert.equal(snap3.state, 'sent');
  assert.equal(snap3.attemptCount, 2);

  // Verify non-due documents remain untouched
  const snap4 = (await db.doc(`notification_outbox/${docFuturePending.eventId}`).get()).data();
  assert.equal(snap4.state, 'pending');
  assert.equal(snap4.attemptCount, 0);

  const snap5 = (await db.doc(`notification_outbox/${docActiveLease.eventId}`).get()).data();
  assert.equal(snap5.state, 'in_progress');
  assert.equal(snap5.ownerToken, 'live_worker_token');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Poisoned prefix does not starve healthy subsequent documents
// ─────────────────────────────────────────────────────────────────────────────

test('E4. Anti-Starvation: Multi-page poisoned prefix does not block healthy subsequent docs across batch boundaries', async () => {
  const healthyCount = 4;
  const poisonCount = 10;
  const batchSize = 4;

  // 1. Seed healthy jobs
  for (let j = 0; j < healthyCount; j++) {
    await seedJob(`job_healthy_${j}`, { status: 'in_progress' });
  }

  // 2. Seed 10 poisoned documents: 5 with missing root keys, 5 with mismatched documentId
  for (let i = 0; i < 5; i++) {
    await db.doc(`notification_outbox/poison_schema_${i}`).set({
      eventId: `poison_schema_${i}`,
      state: 'pending',
      nextAttemptAt: T.fromMillis(clock - 30000 + i * 1000),
      // Missing required schema root keys
    });
  }

  for (let i = 5; i < poisonCount; i++) {
    // Canonical document structure but stored at mismatched document ID
    const mismatchedDoc = canonicalOutboxDoc({
      eventId: `job_in_progress:job_healthy_0`, // Stored eventId contradicts doc ID
      eventType: 'job_in_progress',
      resourceId: 'job_healthy_0',
      state: 'pending',
      nextAttemptAt: T.fromMillis(clock - 30000 + i * 1000),
    });
    await db.doc(`notification_outbox/poison_mismatch_${i}`).set(mismatchedDoc);
  }

  // 3. Seed 4 healthy documents with later due times
  const healthyDocIds = [];
  for (let j = 0; j < healthyCount; j++) {
    const doc = canonicalOutboxDoc({
      eventId: `job_in_progress:job_healthy_${j}`,
      eventType: 'job_in_progress',
      resourceId: `job_healthy_${j}`,
      state: 'pending',
      nextAttemptAt: T.fromMillis(clock - 10000 + j * 1000),
    });
    await seedOutbox(doc);
    healthyDocIds.push(doc.eventId);
  }

  const delivered = [];
  const mockWhatsApp = {
    sendText: async (phone, text) => {
      delivered.push({ phone, text });
      return { messageId: `msg_${delivered.length}` };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  // Batch sweep with batchSize = 4.
  // Must paginate across 4 pages:
  // Page 1: 4 poison docs
  // Page 2: 4 poison docs
  // Page 3: 2 poison docs + 2 healthy docs
  // Page 4: 2 healthy docs -> total delivered = 4 (batchSize met)
  const counts = await manager.deliverPendingNotifications({ batchSize });

  assert.equal(counts.delivered, healthyCount, 'All healthy documents must be delivered across pages');
  assert.equal(counts.failed, poisonCount, 'All 10 poisoned documents must be counted in failed');
  assert.equal(counts.discovered, poisonCount + healthyCount, 'Total 14 documents discovered across pagination');
  assert.equal(delivered.length, healthyCount);

  // Verify all healthy documents are marked 'sent'
  for (const eventId of healthyDocIds) {
    const snap = (await db.doc(`notification_outbox/${eventId}`).get()).data();
    assert.equal(snap.state, 'sent');
  }

  // Verify poisoned documents remain untouched (not mutated to failed_terminal or sent)
  for (let i = 0; i < 5; i++) {
    const snap = (await db.doc(`notification_outbox/poison_schema_${i}`).get()).data();
    assert.equal(snap.state, 'pending');
  }
  for (let i = 5; i < poisonCount; i++) {
    const snap = (await db.doc(`notification_outbox/poison_mismatch_${i}`).get()).data();
    assert.equal(snap.state, 'pending');
    assert.equal(snap.attemptCount, 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Absorbing behavior for sent and failed_terminal
// ─────────────────────────────────────────────────────────────────────────────

test('E5. Absorbing states: sent and failed_terminal documents trigger zero writes and zero provider calls', async () => {
  await seedJob('job_absorb_sent', { status: 'in_progress' });
  await seedJob('job_absorb_failed', { status: 'in_progress' });

  const pastAt = T.fromMillis(clock - 10000);

  const sentDoc = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_absorb_sent',
    eventType: 'job_in_progress',
    resourceId: 'job_absorb_sent',
    state: 'sent',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: 'wam_original_123',
    sentAt: pastAt,
    createdAt: pastAt,
    updatedAt: pastAt,
  });
  await seedOutbox(sentDoc);

  const failedDoc = canonicalOutboxDoc({
    eventId: 'job_in_progress:job_absorb_failed',
    eventType: 'job_in_progress',
    resourceId: 'job_absorb_failed',
    state: 'failed_terminal',
    attemptCount: 5,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    lastErrorCode: 'recipient_unreachable',
    sentAt: null,
    createdAt: pastAt,
    updatedAt: pastAt,
  });
  await seedOutbox(failedDoc);

  let sendCalls = 0;
  const mockWhatsApp = {
    sendText: async () => {
      sendCalls++;
      return { messageId: 'should_not_happen' };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  // Call on sent doc
  const resSent = await manager.deliverNotification(sentDoc.eventId);
  assert.equal(resSent.claimed, false);
  assert.equal(resSent.status, 'sent');

  // Call on failed_terminal doc
  const resFailed = await manager.deliverNotification(failedDoc.eventId);
  assert.equal(resFailed.claimed, false);
  assert.equal(resFailed.status, 'failed_terminal');

  assert.equal(sendCalls, 0, 'WhatsApp must never be called for terminal documents');

  // Verify documents in Firestore are bit-for-bit unchanged
  const postSent = (await db.doc(`notification_outbox/${sentDoc.eventId}`).get()).data();
  assert.equal(postSent.updatedAt.toMillis(), sentDoc.updatedAt.toMillis());
  assert.equal(postSent.providerMessageId, 'wam_original_123');

  const postFailed = (await db.doc(`notification_outbox/${failedDoc.eventId}`).get()).data();
  assert.equal(postFailed.updatedAt.toMillis(), failedDoc.updatedAt.toMillis());
  assert.equal(postFailed.lastErrorCode, 'recipient_unreachable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. End-to-end refund_confirmed delivery with byte-for-byte non-interference
// ─────────────────────────────────────────────────────────────────────────────

test('E6. Non-interference: refund_confirmed delivery leaves jobs and refund_requests byte/semantic unchanged', async () => {
  const jobId = 'job_refund_e2e';

  // Seed canonical jobs doc
  await seedJob(jobId, {
    status: 'cancelled_system',
    cancellationReason: 'no_driver_found',
    cancelledAt: T.fromMillis(clock - 70000),
    cancelledBy: 'system',
    bookingFeePaise: 10000,
    refundRequestId: jobId,
    refundState: 'confirmed',
    razorpayRefundId: 'rfnd_CANONICAL123',
    refundConfirmedAt: T.fromMillis(clock - 10000),
    refundedAmountPaise: 10000,
    refundNextAttemptAt: null,
    customerPhone: '+919876543210',
  });

  // Seed canonical refund_requests doc
  await seedRefundRequest(jobId, {
    jobId,
    amountPaise: 10000,
    reason: 'no_driver_found',
    state: 'confirmed',
    razorpayRefundId: 'rfnd_CANONICAL123',
    confirmedAt: T.fromMillis(clock - 10000),
  });

  // Capture pre-notification state
  const jobBefore = (await db.doc(`jobs/${jobId}`).get()).data();
  const refundBefore = (await db.doc(`refund_requests/${jobId}`).get()).data();

  // Seed notification_outbox doc
  const outboxDoc = canonicalOutboxDoc({
    eventId: `refund_confirmed:${jobId}`,
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: jobId,
    recipientKey: `customer:${jobId}`,
    payload: {
      jobId,
      jobStatus: 'cancelled_system',
      refundAmountPaise: 10000,
    },
    state: 'pending',
    attemptCount: 0,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: T.fromMillis(clock),
  });
  await seedOutbox(outboxDoc);

  let deliveredText = null;
  let deliveredPhone = null;

  const mockWhatsApp = {
    sendText: async (phone, text) => {
      deliveredPhone = phone;
      deliveredText = text;
      return { messageId: 'wam_refund_success_123' };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  const res = await manager.deliverNotification(outboxDoc.eventId);
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'sent');

  // Verify delivery message text
  assert.equal(deliveredPhone, '+919876543210');
  assert.equal(
    deliveredText,
    'A refund of INR 100.00 for booking job_refund_e2e has been processed to your original payment method.'
  );

  // Verify notification_outbox transitioned to sent
  const outboxAfter = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(outboxAfter.state, 'sent');
  assert.equal(outboxAfter.attemptCount, 1);
  assert.equal(outboxAfter.providerMessageId, 'wam_refund_success_123');
  assert.equal(outboxAfter.ownerToken, null);
  assert.equal(outboxAfter.leaseUntil, null);
  assert.ok(outboxAfter.sentAt !== null);

  // Verify jobs and refund_requests are byte/semantic identical
  const jobAfter = (await db.doc(`jobs/${jobId}`).get()).data();
  const refundAfter = (await db.doc(`refund_requests/${jobId}`).get()).data();

  assert.deepStrictEqual(jobAfter, jobBefore, 'jobs collection must NOT be mutated by notification delivery');
  assert.deepStrictEqual(refundAfter, refundBefore, 'refund_requests collection must NOT be mutated by notification delivery');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Missing job or unreachable recipient transitions to failed_terminal
// ─────────────────────────────────────────────────────────────────────────────

test('E7. Error handling: missing job in Firestore transitions to failed_terminal with zero HTTP', async () => {
  const missingJobId = 'job_does_not_exist';
  const outboxDoc = canonicalOutboxDoc({
    eventId: `job_in_progress:${missingJobId}`,
    eventType: 'job_in_progress',
    resourceId: missingJobId,
    recipientKey: `customer:${missingJobId}`,
    state: 'pending',
  });
  await seedOutbox(outboxDoc);

  let sendCalls = 0;
  const mockWhatsApp = {
    sendText: async () => {
      sendCalls++;
      return { messageId: 'should_not_call' };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  const res = await manager.deliverNotification(outboxDoc.eventId);
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(sendCalls, 0);

  const outboxAfter = (await db.doc(`notification_outbox/${outboxDoc.eventId}`).get()).data();
  assert.equal(outboxAfter.state, 'failed_terminal');
  assert.equal(outboxAfter.lastErrorCode, 'recipient_unreachable');
  assert.equal(outboxAfter.attemptCount, 1);
  assert.equal(outboxAfter.ownerToken, null);
  assert.equal(outboxAfter.leaseUntil, null);
  assert.equal(outboxAfter.nextAttemptAt, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Document-Identity Binding (Real Firestore Emulator)
// ─────────────────────────────────────────────────────────────────────────────

test('E8. Document-Identity Binding: Mismatched document ID returns malformed with zero writes and zero HTTP', async () => {
  const jobId = 'job_identity_emu';
  await seedJob(jobId, { status: 'completed' });

  const canonicalEventId = `job_completed:${jobId}`;
  const outboxDoc = canonicalOutboxDoc({
    eventId: canonicalEventId,
    eventType: 'job_completed',
    resourceId: jobId,
    recipientKey: `customer:${jobId}`,
    payload: {
      jobId,
      jobStatus: 'completed',
      refundAmountPaise: null,
    },
    state: 'pending',
    nextAttemptAt: T.fromMillis(clock),
  });

  // Seed canonical document
  await seedOutbox(outboxDoc);

  // Seed duplicate occurrence at an unexpected alias document ID
  const aliasDocId = 'unexpected_document_id';
  await db.doc(`notification_outbox/${aliasDocId}`).set(outboxDoc);

  let providerCalls = 0;
  const mockWhatsApp = {
    sendText: async () => {
      providerCalls++;
      return { messageId: `wamid.identity_${providerCalls}` };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: mockWhatsApp,
    TimestampClass: T,
    now,
  });

  // 1. Deliver canonical doc -> succeeds
  const canonicalRes = await manager.deliverNotification(canonicalEventId);
  assert.equal(canonicalRes.claimed, true);
  assert.equal(canonicalRes.status, 'sent');
  assert.equal(providerCalls, 1);

  // 2. Deliver aliased doc -> rejected as malformed with 0 writes and 0 provider calls
  const aliasRes = await manager.deliverNotification(aliasDocId);
  assert.equal(aliasRes.claimed, false);
  assert.equal(aliasRes.status, 'malformed');
  assert.equal(providerCalls, 1, 'Provider calls must remain 1');

  // Verify aliased document in Firestore is completely unchanged (still pending, attemptCount: 0)
  const aliasSnap = (await db.doc(`notification_outbox/${aliasDocId}`).get()).data();
  assert.equal(aliasSnap.state, 'pending');
  assert.equal(aliasSnap.attemptCount, 0);
  assert.equal(aliasSnap.providerMessageId, null);
  assert.notEqual(aliasRes.status, 'failed_terminal');

  // 3. Even if aliased doc already had state: 'sent', deliverNotification(aliasDocId) must return malformed
  await db.doc(`notification_outbox/${aliasDocId}`).update({ state: 'sent', providerMessageId: 'wamid.sent_fake', sentAt: T.fromMillis(clock) });
  const aliasSentRes = await manager.deliverNotification(aliasDocId);
  assert.equal(aliasSentRes.claimed, false);
  assert.equal(aliasSentRes.status, 'malformed', 'Mismatched docId must return malformed even when state is sent');
  assert.equal(providerCalls, 1);
});
