'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { Timestamp } = require('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: 'test-project' });

const {
  LEASE_DURATION_MS,
  MAX_ATTEMPTS,
  OUTBOX_EXACT_KEYS,
  OUTBOX_ALLOWED_EVENT_TYPES,
  OUTBOX_ALLOWED_STATES,
  OUTBOX_ALLOWED_ERROR_CODES,
  EVENT_CONFIGS,
  validateCanonicalNotificationOutbox,
  renderNotificationMessage,
  calculateBackoffMs,
  classifyProviderError,
  assertWhatsAppConfig,
  createNotificationDeliveryManager,
  shouldProcessNotificationCreated,
} = require('../../../firebase/functions/src/dispatch/notificationDelivery');
const s9 = require('../../../firebase/functions/src/dispatch/noDriverRefund');
const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');

class TestTimestamp extends FakeTimestamp {
  valueOf() { return this.ms; }
}

function makeCanonicalRefundPair(jobId, amountPaise = 10000, nowMs = 1_000_000, overrides = {}) {
  const paymentId = overrides.razorpayPaymentId || 'pay_AuditVerified';
  const refundId = overrides.razorpayRefundId || 'rfnd_AuditVerified';
  const expectedKey = 'refund_no_driver_found_' + jobId;
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId,
    amount: amountPaise,
  }), 'utf8').digest('hex');

  const refund = {
    operationId: jobId,
    jobId,
    razorpayPaymentId: paymentId,
    amountPaise,
    reason: 'no_driver_found',
    providerIdempotencyKey: expectedKey,
    providerRequestHash: expectedHash,
    state: 'confirmed',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    reconciliationNextAttemptAt: null,
    reconciliationAttempts: 1,
    razorpayRefundId: refundId,
    confirmationSource: 'reconciliation',
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: TestTimestamp.fromMillis(nowMs - 60000),
    updatedAt: TestTimestamp.fromMillis(nowMs - 10000),
    submittedAt: TestTimestamp.fromMillis(nowMs - 30000),
    confirmedAt: TestTimestamp.fromMillis(nowMs - 10000),
    ...overrides.refund,
  };

  const job = {
    jobId,
    status: 'cancelled_system',
    dispatchState: 'closed',
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    cancelledAt: TestTimestamp.fromMillis(nowMs - 60000),
    refundRequestId: jobId,
    refundState: 'confirmed',
    refundNextAttemptAt: null,
    razorpayRefundId: refundId,
    refundConfirmedAt: TestTimestamp.fromMillis(nowMs - 10000),
    refundedAmountPaise: amountPaise,
    bookingFeePaise: amountPaise,
    razorpayPaymentId: paymentId,
    paymentConfirmedAt: TestTimestamp.fromMillis(nowMs - 120000),
    customerPhone: '+919876543210',
    createdAt: TestTimestamp.fromMillis(nowMs - 180000),
    updatedAt: TestTimestamp.fromMillis(nowMs - 10000),
    ...overrides.job,
  };

  return { job, refund };
}

function setupHarness({
  nowMs = 1_000_000,
  jobPatch = {},
  outboxPatch = {},
  whatsappMock = null,
  env = {
    WHATSAPP_ACCESS_TOKEN: 'valid_token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_GRAPH_API_VERSION: 'v21.0',
  },
} = {}) {
  const db = new FakeFirestore();
  const jobId = outboxPatch.resourceId || 'job_1';
  const eventType = outboxPatch.eventType || 'job_accepted';
  const offerId = outboxPatch.offerId || 'off_1';

  let eventId = outboxPatch.eventId;
  if (!eventId) {
    eventId = eventType === 'job_accepted' ? `job_accepted:${jobId}:${offerId}` : `${eventType}:${jobId}`;
  }

  const at = TestTimestamp.fromMillis(nowMs);
  const state = outboxPatch.state || 'pending';
  const attemptCount = outboxPatch.attemptCount !== undefined ? outboxPatch.attemptCount : (state === 'pending' ? 0 : 1);
  const resourceType = outboxPatch.resourceType || (eventType === 'refund_confirmed' ? 'refund_request' : 'job');
  const jobStatus = outboxPatch.payload?.jobStatus || EVENT_CONFIGS[eventType]?.jobStatus || 'accepted';
  const refundAmountPaise = eventType === 'refund_confirmed' ? (outboxPatch.payload?.refundAmountPaise || 10000) : null;

  db.seed('jobs', jobId, {
    jobId,
    customerPhone: '+919876543210',
    status: jobStatus,
    bookingFeePaise: 10000,
    ...jobPatch,
  });

  const seededOutbox = {
    eventId,
    eventType,
    resourceType,
    resourceId: jobId,
    channel: 'whatsapp',
    recipientKey: 'customer:' + jobId,
    payloadVersion: 1,
    payload: {
      jobId,
      jobStatus,
      refundAmountPaise,
    },
    state,
    ownerToken: state === 'in_progress' ? (outboxPatch.ownerToken || 'token_1') : null,
    leaseUntil: state === 'in_progress' ? (outboxPatch.leaseUntil || TestTimestamp.fromMillis(nowMs + 60000)) : null,
    nextAttemptAt: (state === 'pending' || state === 'retry_wait') ? (outboxPatch.nextAttemptAt || at) : null,
    attemptCount,
    providerMessageId: state === 'sent' ? (outboxPatch.providerMessageId || 'wamid.HBg123') : null,
    lastErrorCode: (state === 'retry_wait' || state === 'failed_terminal') ? (outboxPatch.lastErrorCode || 'provider_unavailable') : null,
    createdAt: outboxPatch.createdAt || at,
    updatedAt: outboxPatch.updatedAt || at,
    sentAt: state === 'sent' ? (outboxPatch.sentAt || at) : null,
    ...outboxPatch,
  };

  db.seed('notification_outbox', eventId, seededOutbox);

  const calls = { sends: [] };
  const whatsapp = whatsappMock || {
    sendText: async (to, text) => {
      calls.sends.push({ to, text });
      return { messageId: 'wamid.HBg' + crypto.randomBytes(4).toString('hex') };
    },
  };

  const manager = createNotificationDeliveryManager({
    db,
    whatsapp,
    TimestampClass: TestTimestamp,
    now: () => new Date(nowMs),
    env,
  });

  return { db, manager, calls, jobId, eventId, nowMs, seededOutbox };
}

// ============================================================================
// 1. CANONICAL VALIDATOR TESTS
// ============================================================================

test('V1. validateCanonicalNotificationOutbox validates all 6 canonical events in pending state', () => {
  const at = TestTimestamp.fromMillis(1000000);
  const events = [
    { eventType: 'job_accepted', eventId: 'job_accepted:j1:o1', resourceType: 'job', jobStatus: 'accepted', refundAmountPaise: null },
    { eventType: 'job_in_progress', eventId: 'job_in_progress:j1', resourceType: 'job', jobStatus: 'in_progress', refundAmountPaise: null },
    { eventType: 'job_completed', eventId: 'job_completed:j1', resourceType: 'job', jobStatus: 'completed', refundAmountPaise: null },
    { eventType: 'job_cancelled_customer', eventId: 'job_cancelled_customer:j1', resourceType: 'job', jobStatus: 'cancelled_customer', refundAmountPaise: null },
    { eventType: 'job_cancelled_system', eventId: 'job_cancelled_system:j1', resourceType: 'job', jobStatus: 'cancelled_system', refundAmountPaise: null },
    { eventType: 'refund_confirmed', eventId: 'refund_confirmed:j1', resourceType: 'refund_request', jobStatus: 'cancelled_system', refundAmountPaise: 5000 },
  ];

  for (const ev of events) {
    const doc = {
      eventId: ev.eventId,
      eventType: ev.eventType,
      resourceType: ev.resourceType,
      resourceId: 'j1',
      channel: 'whatsapp',
      recipientKey: 'customer:j1',
      payloadVersion: 1,
      payload: { jobId: 'j1', jobStatus: ev.jobStatus, refundAmountPaise: ev.refundAmountPaise },
      state: 'pending',
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: at,
      attemptCount: 0,
      providerMessageId: null,
      lastErrorCode: null,
      createdAt: at,
      updatedAt: at,
      sentAt: null,
    };
    assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp }), true, `Event ${ev.eventType} failed validation`);
  }
});

test('V2. validateCanonicalNotificationOutbox rejects non-objects, arrays, and null', () => {
  assert.equal(validateCanonicalNotificationOutbox(null), false);
  assert.equal(validateCanonicalNotificationOutbox(undefined), false);
  assert.equal(validateCanonicalNotificationOutbox([]), false);
  assert.equal(validateCanonicalNotificationOutbox('string'), false);
});

test('V3. validateCanonicalNotificationOutbox rejects extra root keys or missing root keys', () => {
  const at = TestTimestamp.fromMillis(1000000);
  const base = {
    eventId: 'job_in_progress:j1',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j1',
    channel: 'whatsapp',
    recipientKey: 'customer:j1',
    payloadVersion: 1,
    payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  };

  // Missing root key
  const missing = { ...base };
  delete missing.sentAt;
  assert.equal(validateCanonicalNotificationOutbox(missing, { TimestampClass: TestTimestamp }), false);

  // Extra root key
  const extra = { ...base, extraField: true };
  assert.equal(validateCanonicalNotificationOutbox(extra, { TimestampClass: TestTimestamp }), false);
});

test('V4. validateCanonicalNotificationOutbox rejects invalid event bindings and payload shape', () => {
  const at = TestTimestamp.fromMillis(1000000);
  const valid = {
    eventId: 'job_in_progress:j1',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j1',
    channel: 'whatsapp',
    recipientKey: 'customer:j1',
    payloadVersion: 1,
    payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  };

  // Wrong eventId for job_accepted (missing offerId)
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, eventType: 'job_accepted', eventId: 'job_accepted:j1' }), false);

  // Wrong resourceType for job event
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, resourceType: 'refund_request' }), false);

  // Wrong channel
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, channel: 'sms' }), false);

  // Raw phone in recipientKey
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, recipientKey: '+919876543210' }), false);

  // Wrong payload version
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, payloadVersion: 2 }), false);

  // Missing payload key
  const missingPayloadKey = { ...valid, payload: { jobId: 'j1', jobStatus: 'in_progress' } };
  assert.equal(validateCanonicalNotificationOutbox(missingPayloadKey), false);

  // Non-null refundAmountPaise on job event
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: 5000 } }), false);

  // Null refundAmountPaise on refund_confirmed
  const badRefund = {
    ...valid,
    eventType: 'refund_confirmed',
    eventId: 'refund_confirmed:j1',
    resourceType: 'refund_request',
    payload: { jobId: 'j1', jobStatus: 'cancelled_system', refundAmountPaise: null },
  };
  assert.equal(validateCanonicalNotificationOutbox(badRefund), false);
});

test('V5. validateCanonicalNotificationOutbox rejects invalid timestamps and ordering', () => {
  const early = TestTimestamp.fromMillis(1000000);
  const late = TestTimestamp.fromMillis(2000000);
  const valid = {
    eventId: 'job_in_progress:j1',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j1',
    channel: 'whatsapp',
    recipientKey: 'customer:j1',
    payloadVersion: 1,
    payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: early,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: late,
    updatedAt: early, // Inverted: createdAt > updatedAt
    sentAt: null,
  };
  assert.equal(validateCanonicalNotificationOutbox(valid, { TimestampClass: TestTimestamp }), false);

  // Non-timestamp createdAt
  assert.equal(validateCanonicalNotificationOutbox({ ...valid, createdAt: '2026-09-02' }, { TimestampClass: TestTimestamp }), false);
});

test('V6. validateCanonicalNotificationOutbox rejects state invariant violations', () => {
  const at = TestTimestamp.fromMillis(1000000);
  const base = {
    eventId: 'job_in_progress:j1',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j1',
    channel: 'whatsapp',
    recipientKey: 'customer:j1',
    payloadVersion: 1,
    payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: null },
    createdAt: at,
    updatedAt: at,
  };

  // Pending with attemptCount != 0
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'pending', ownerToken: null, leaseUntil: null, nextAttemptAt: at, attemptCount: 1, providerMessageId: null, lastErrorCode: null, sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // in_progress with attemptCount < 1
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'in_progress', ownerToken: 'tok', leaseUntil: at, nextAttemptAt: null, attemptCount: 0, providerMessageId: null, lastErrorCode: null, sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // retry_wait with ownerToken != null
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'retry_wait', ownerToken: 'tok', leaseUntil: null, nextAttemptAt: at, attemptCount: 1, providerMessageId: null, lastErrorCode: 'provider_unavailable', sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // sent with providerMessageId == null
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'sent', ownerToken: null, leaseUntil: null, nextAttemptAt: null, attemptCount: 1, providerMessageId: null, lastErrorCode: null, sentAt: at,
  }, { TimestampClass: TestTimestamp }), false);

  // sent with non-null lastErrorCode
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'sent', ownerToken: null, leaseUntil: null, nextAttemptAt: null, attemptCount: 1, providerMessageId: 'wamid.123', lastErrorCode: 'provider_unavailable', sentAt: at,
  }, { TimestampClass: TestTimestamp }), false);

  // failed_terminal with non-null providerMessageId
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'failed_terminal', ownerToken: null, leaseUntil: null, nextAttemptAt: null, attemptCount: 1, providerMessageId: 'wamid.contradictory', lastErrorCode: 'provider_rejected_message', sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // failed_terminal with non-null nextAttemptAt
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'failed_terminal', ownerToken: null, leaseUntil: null, nextAttemptAt: at, attemptCount: 1, providerMessageId: null, lastErrorCode: 'provider_rejected_message', sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // failed_terminal with null lastErrorCode
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'failed_terminal', ownerToken: null, leaseUntil: null, nextAttemptAt: null, attemptCount: 1, providerMessageId: null, lastErrorCode: null, sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);

  // unknown lastErrorCode
  assert.equal(validateCanonicalNotificationOutbox({
    ...base, state: 'failed_terminal', ownerToken: null, leaseUntil: null, nextAttemptAt: null, attemptCount: 1, providerMessageId: null, lastErrorCode: 'unauthorized_error_code', sentAt: null,
  }, { TimestampClass: TestTimestamp }), false);
});

test('V7. validateCanonicalNotificationOutbox strictly enforces terminal state invariants (A-J matrix)', () => {
  const at = TestTimestamp.fromMillis(1000000);
  const canonicalBase = {
    eventId: 'refund_confirmed:auditjob',
    eventType: 'refund_confirmed',
    resourceType: 'refund_request',
    resourceId: 'auditjob',
    channel: 'whatsapp',
    recipientKey: 'customer:auditjob',
    payloadVersion: 1,
    payload: { jobId: 'auditjob', jobStatus: 'cancelled_system', refundAmountPaise: 10000 },
    createdAt: at,
    updatedAt: at,
  };

  // A. failed_terminal + providerMessageId null => canonical
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), true, 'A: failed_terminal with null providerMessageId must be canonical');

  // B. failed_terminal + nonempty providerMessageId => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: 'wamid.contradictory',
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'B: failed_terminal with nonempty providerMessageId must be rejected');

  // C. failed_terminal + blank providerMessageId => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: '   ',
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'C: failed_terminal with blank providerMessageId must be rejected');
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: '',
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'C: failed_terminal with empty string providerMessageId must be rejected');

  // D. failed_terminal + sentAt non-null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: at,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'D: failed_terminal with non-null sentAt must be rejected');

  // E. failed_terminal + ownerToken non-null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: 'worker_token',
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'E: failed_terminal with non-null ownerToken must be rejected');

  // F. failed_terminal + leaseUntil non-null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: at,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'F: failed_terminal with non-null leaseUntil must be rejected');

  // G. failed_terminal + nextAttemptAt non-null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    providerMessageId: null,
    sentAt: null,
    lastErrorCode: 'provider_rejected_message',
  }, { TimestampClass: TestTimestamp }), false, 'G: failed_terminal with non-null nextAttemptAt must be rejected');

  // H. failed_terminal + lastErrorCode null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'failed_terminal',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: null,
    lastErrorCode: null,
  }, { TimestampClass: TestTimestamp }), false, 'H: failed_terminal with null lastErrorCode must be rejected');

  // I. sent + canonical providerMessageId + sentAt => still canonical
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'sent',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
    sentAt: at,
    lastErrorCode: null,
  }, { TimestampClass: TestTimestamp }), true, 'I: sent with canonical providerMessageId and sentAt must be canonical');

  // J. sent + providerMessageId null => rejected
  assert.equal(validateCanonicalNotificationOutbox({
    ...canonicalBase,
    state: 'sent',
    attemptCount: 1,
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    providerMessageId: null,
    sentAt: at,
    lastErrorCode: null,
  }, { TimestampClass: TestTimestamp }), false, 'J: sent with null providerMessageId must be rejected');
});

test('V8. validateCanonicalNotificationOutbox sent chronology matrix (A-H)', async () => {
  const tSec = 1900000000;
  const createdAt = new TestTimestamp(tSec, 500);
  const updatedAt = new TestTimestamp(tSec + 10, 500);

  function makeSentDoc(sentAt, created = createdAt, updated = updatedAt) {
    return {
      eventId: 'refund_confirmed:auditjob',
      eventType: 'refund_confirmed',
      resourceType: 'refund_request',
      resourceId: 'auditjob',
      channel: 'whatsapp',
      recipientKey: 'customer:auditjob',
      payloadVersion: 1,
      payload: { jobId: 'auditjob', jobStatus: 'cancelled_system', refundAmountPaise: 10000 },
      state: 'sent',
      attemptCount: 1,
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      providerMessageId: 'wamid.canonical',
      lastErrorCode: null,
      createdAt: created,
      updatedAt: updated,
      sentAt,
    };
  }

  async function testChronologyCase(sentAt, created, updated, expectValid, desc) {
    const doc = makeSentDoc(sentAt, created, updated);
    const valid = validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp });
    assert.equal(valid, expectValid, `${desc}: validator expectation mismatch`);

    let calls = 0;
    const { manager, db, eventId } = setupHarness({
      outboxPatch: doc,
      whatsappMock: {
        sendText: async () => {
          calls++;
          throw new Error('Unexpected provider call');
        },
      },
    });
    db.seed('notification_outbox', eventId, doc);
    const initialDoc = db.read('notification_outbox', eventId);

    const res = await manager.deliverNotification(eventId);
    assert.equal(calls, 0, `${desc}: zero provider calls`);
    assert.deepEqual(db.read('notification_outbox', eventId), initialDoc, `${desc}: zero mutation`);

    if (expectValid) {
      assert.equal(res.claimed, false);
      assert.equal(res.status, 'sent');
    } else {
      assert.equal(res.claimed, false);
      assert.equal(res.status, 'malformed');
    }
  }

  // A. sentAt < createdAt by 1 millisecond => reject
  const sentAtA = TestTimestamp.fromMillis(createdAt.toMillis() - 1);
  await testChronologyCase(sentAtA, createdAt, updatedAt, false, 'A. sentAt < createdAt by 1ms');

  // B. sentAt < createdAt by 1 nanosecond if Timestamp supports it => reject
  const sentAtB = new TestTimestamp(tSec, 499);
  await testChronologyCase(sentAtB, createdAt, updatedAt, false, 'B. sentAt < createdAt by 1ns');

  // C. sentAt === createdAt => accept if all other fields canonical
  const sentAtC = new TestTimestamp(tSec, 500);
  await testChronologyCase(sentAtC, createdAt, updatedAt, true, 'C. sentAt === createdAt');

  // D. createdAt < sentAt < updatedAt => accept
  const sentAtD = new TestTimestamp(tSec + 5, 500);
  await testChronologyCase(sentAtD, createdAt, updatedAt, true, 'D. createdAt < sentAt < updatedAt');

  // E. sentAt === updatedAt => accept
  const sentAtE = new TestTimestamp(tSec + 10, 500);
  await testChronologyCase(sentAtE, createdAt, updatedAt, true, 'E. sentAt === updatedAt');

  // F. sentAt > updatedAt by 1 millisecond => reject
  const sentAtF = TestTimestamp.fromMillis(updatedAt.toMillis() + 1);
  await testChronologyCase(sentAtF, createdAt, updatedAt, false, 'F. sentAt > updatedAt by 1ms');

  // G. sentAt > updatedAt by 1 nanosecond if supported => reject
  const sentAtG = new TestTimestamp(tSec + 10, 501);
  await testChronologyCase(sentAtG, createdAt, updatedAt, false, 'G. sentAt > updatedAt by 1ns');

  // H. createdAt > updatedAt => reject as already required
  const badCreated = new TestTimestamp(tSec + 20, 0);
  const badUpdated = new TestTimestamp(tSec, 0);
  const sentAtH = new TestTimestamp(tSec + 10, 0);
  await testChronologyCase(sentAtH, badCreated, badUpdated, false, 'H. createdAt > updatedAt');
});

// ============================================================================
// 2. MESSAGE RENDERING & REFUND FORMATTING TESTS
// ============================================================================

test('M1. renderNotificationMessage renders all 6 Stage 10 v1 messages accurately', () => {
  const jobId = 'JOB_ABC123';
  assert.equal(renderNotificationMessage('job_accepted', { jobId }), 'Your towing request JOB_ABC123 has been accepted by a driver.');
  assert.equal(renderNotificationMessage('job_in_progress', { jobId }), 'Your towing job JOB_ABC123 is now in progress.');
  assert.equal(renderNotificationMessage('job_completed', { jobId }), 'Your towing job JOB_ABC123 has been completed.');
  assert.equal(renderNotificationMessage('job_cancelled_customer', { jobId }), 'Your towing job JOB_ABC123 has been cancelled.');
  assert.equal(renderNotificationMessage('job_cancelled_system', { jobId }), 'Your towing request JOB_ABC123 was cancelled because no driver was available.');
  assert.equal(
    renderNotificationMessage('refund_confirmed', { jobId, refundAmountPaise: 50000 }),
    'A refund of INR 500.00 for booking JOB_ABC123 has been processed to your original payment method.'
  );
});

test('M2. refund formatting formats paise to rupees with exact two decimal places', () => {
  const cases = [
    { paise: 10000, expected: '100.00' },
    { paise: 12345, expected: '123.45' },
    { paise: 50, expected: '0.50' },
    { paise: 5, expected: '0.05' },
    { paise: 100000, expected: '1000.00' },
  ];
  for (const { paise, expected } of cases) {
    const rendered = renderNotificationMessage('refund_confirmed', { jobId: 'J1', refundAmountPaise: paise });
    assert.match(rendered, new RegExp(`INR ${expected} for booking J1`));
  }
});

// ============================================================================
// 3. CLAIM SEMANTICS TESTS
// ============================================================================

test('C1. Canonical pending claim advances to in_progress with attemptCount: 1, ownerToken, and 60s lease', async () => {
  const { manager, db, eventId, nowMs } = setupHarness();
  const res = await manager.deliverNotification(eventId);

  assert.equal(res.finalized, true);
  assert.equal(res.status, 'sent');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'sent');
  assert.equal(after.attemptCount, 1);
  assert.equal(after.ownerToken, null);
  assert.equal(after.leaseUntil, null);
  assert.equal(after.lastErrorCode, null);
  assert.match(after.providerMessageId, /^wamid\./);
  assert.equal(after.sentAt.toMillis(), nowMs);
});

test('C2. Pending not due is skipped without mutation or provider call', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId, calls } = setupHarness({
    nowMs,
    outboxPatch: { nextAttemptAt: TestTimestamp.fromMillis(nowMs + 10000) },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'not_due');
  assert.equal(calls.sends.length, 0);

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'pending');
  assert.equal(after.attemptCount, 0);
});

test('C3. Retry_wait claim advances to in_progress with attemptCount incremented', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'retry_wait',
      attemptCount: 2,
      lastErrorCode: 'provider_unavailable',
      nextAttemptAt: TestTimestamp.fromMillis(nowMs - 1000),
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'sent');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'sent');
  assert.equal(after.attemptCount, 3); // 2 -> 3 during claim
});

test('C4. Retry_wait not due is skipped', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId, calls } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'retry_wait',
      attemptCount: 1,
      lastErrorCode: 'provider_rate_limited',
      nextAttemptAt: TestTimestamp.fromMillis(nowMs + 5000),
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'not_due');
  assert.equal(calls.sends.length, 0);
});

test('C5. in_progress with active lease is skipped with active_lease', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId, calls } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'in_progress',
      attemptCount: 1,
      ownerToken: 'worker_active',
      leaseUntil: TestTimestamp.fromMillis(nowMs + 30000),
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'active_lease');
  assert.equal(calls.sends.length, 0);

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.ownerToken, 'worker_active');
});

test('C6. Expired in_progress lease is reclaimed by new worker', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'in_progress',
      attemptCount: 1,
      ownerToken: 'worker_stale',
      leaseUntil: TestTimestamp.fromMillis(nowMs - 1000),
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'sent');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'sent');
  assert.equal(after.attemptCount, 2);
});

test('C7. Exact lease-boundary reclaim (leaseUntil == now) is permitted', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'in_progress',
      attemptCount: 1,
      ownerToken: 'worker_boundary',
      leaseUntil: TestTimestamp.fromMillis(nowMs), // exact boundary
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'sent');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'sent');
  assert.equal(after.attemptCount, 2);
});

test('C8. Attempt count boundary: failure at attempt 5 transitions to failed_terminal with zero 6th attempt', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'retry_wait',
      attemptCount: 4,
      lastErrorCode: 'provider_unavailable',
      nextAttemptAt: TestTimestamp.fromMillis(nowMs - 1000),
    },
    whatsappMock: {
      sendText: async () => {
        const err = new Error('Network timeout');
        err.name = 'AbortError';
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'provider_unavailable');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'failed_terminal');
  assert.equal(after.attemptCount, 5); // 4 -> 5 during claim
  assert.equal(after.lastErrorCode, 'provider_unavailable');
  assert.equal(after.ownerToken, null);
  assert.equal(after.leaseUntil, null);

  // Subsequent delivery attempts are absorbed as terminal
  const nextTry = await manager.deliverNotification(eventId);
  assert.equal(nextTry.claimed, false);
  assert.equal(nextTry.status, 'failed_terminal');
  assert.equal(db.read('notification_outbox', eventId).attemptCount, 5);
});

// ============================================================================
// 4. ABSORBING STATES
// ============================================================================

test('A1. Canonical sent document is absorbing: zero provider calls, zero writes', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId, calls, seededOutbox } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'sent',
      attemptCount: 1,
      providerMessageId: 'wamid.EXISTING',
      createdAt: TestTimestamp.fromMillis(nowMs - 5000),
      sentAt: TestTimestamp.fromMillis(nowMs),
      updatedAt: TestTimestamp.fromMillis(nowMs),
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'sent');
  assert.equal(calls.sends.length, 0);

  const after = db.read('notification_outbox', eventId);
  assert.deepEqual(after, seededOutbox);
});

test('A2. Canonical failed_terminal document is absorbing: zero provider calls, zero writes', async () => {
  const { manager, db, eventId, calls, seededOutbox } = setupHarness({
    outboxPatch: {
      state: 'failed_terminal',
      attemptCount: 5,
      lastErrorCode: 'provider_rejected_message',
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(calls.sends.length, 0);

  const after = db.read('notification_outbox', eventId);
  assert.deepEqual(after, seededOutbox);
});

// ============================================================================
// 5. ERROR CLASSIFICATION & RETRY / TERMINAL TRANSITIONS
// ============================================================================

test('E1. Timeout error transitions in_progress to retry_wait with 30s backoff on attempt 1', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp request timed out');
        err.name = 'AbortError';
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.lastErrorCode, 'provider_unavailable');
  assert.equal(res.nextAttemptAt.toMillis(), nowMs + 30000);

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'retry_wait');
  assert.equal(after.attemptCount, 1);
  assert.equal(after.lastErrorCode, 'provider_unavailable');
  assert.equal(after.nextAttemptAt.toMillis(), nowMs + 30000);
});

test('E2. Network error transitions in_progress to retry_wait', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('fetch failed: econnrefused');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.lastErrorCode, 'provider_unavailable');
});

test('E3. 429 Rate limited transitions in_progress to retry_wait', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp API error: 429 (#130429) Rate limit hit');
        err.status = 429;
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.lastErrorCode, 'provider_rate_limited');
});

test('E4. 5xx Server error transitions in_progress to retry_wait', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp API error: 503 Service Unavailable');
        err.status = 503;
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'retry_wait');
  assert.equal(res.lastErrorCode, 'provider_unavailable');
});

test('E5. Permanent 4xx / Meta 24-hr window error transitions in_progress to failed_terminal', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp API error: 400 (#131047) Re-engagement message outside 24-hr window');
        err.status = 400;
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'provider_rejected_message');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'failed_terminal');
  assert.equal(after.lastErrorCode, 'provider_rejected_message');
});

test('E6. Invalid recipient phone transitions in_progress to failed_terminal with recipient_unreachable and zero HTTP', async () => {
  const { manager, db, eventId, calls } = setupHarness({
    jobPatch: { customerPhone: 'invalid_phone_number' },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'recipient_unreachable');
  assert.equal(calls.sends.length, 0);

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'failed_terminal');
  assert.equal(after.lastErrorCode, 'recipient_unreachable');
});

test('E7. Missing job transitions in_progress to failed_terminal with recipient_unreachable and zero HTTP', async () => {
  const { manager, db, eventId, calls, jobId } = setupHarness();
  delete db.data.jobs[jobId]; // remove job

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'recipient_unreachable');
  assert.equal(calls.sends.length, 0);
});

test('E8. Missing required configuration transitions in_progress to failed_terminal with zero HTTP', async () => {
  const { manager, db, eventId, calls } = setupHarness({
    env: {
      WHATSAPP_ACCESS_TOKEN: '', // missing token
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'configuration_missing');
  assert.equal(calls.sends.length, 0);
});

test('E9. Missing phone number ID transitions to failed_terminal with configuration_missing', async () => {
  const { manager, db, eventId, calls } = setupHarness({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_PHONE_NUMBER_ID: '', // missing
      WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'configuration_missing');
  assert.equal(calls.sends.length, 0);
});

test('E10. Invalid Graph API version transitions to failed_terminal with configuration_missing', async () => {
  const { manager, db, eventId, calls } = setupHarness({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_GRAPH_API_VERSION: 'invalid_version', // invalid format
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'configuration_missing');
  assert.equal(calls.sends.length, 0);
});

test('E11. Empty providerMessageId in response causes failed_terminal', async () => {
  const { manager, db, eventId } = setupHarness({
    whatsappMock: {
      sendText: async () => ({ messageId: '' }), // invalid empty messageId
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'provider_rejected_message');
});

test('W1. production terminal writer produces canonical failed_terminal document passing validator', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp API error: 400 (#131047) Re-engagement message outside 24-hr window');
        err.status = 400;
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'provider_rejected_message');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'failed_terminal');
  assert.equal(after.attemptCount, 1);
  assert.equal(after.providerMessageId, null);
  assert.equal(after.sentAt, null);
  assert.equal(after.ownerToken, null);
  assert.equal(after.leaseUntil, null);
  assert.equal(after.nextAttemptAt, null);
  assert.equal(after.lastErrorCode, 'provider_rejected_message');
  assert.equal(validateCanonicalNotificationOutbox(after, { TimestampClass: TestTimestamp }), true);
});

test('W2. attempt-five terminalization produces canonical failed_terminal document with providerMessageId === null', async () => {
  const nowMs = 1_000_000;
  const { manager, db, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      state: 'retry_wait',
      attemptCount: 4,
      lastErrorCode: 'provider_unavailable',
      nextAttemptAt: TestTimestamp.fromMillis(nowMs - 1000),
    },
    whatsappMock: {
      sendText: async () => {
        const err = new Error('WhatsApp API error: 503 Service Unavailable');
        err.status = 503;
        throw err;
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'provider_unavailable');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'failed_terminal');
  assert.equal(after.attemptCount, 5);
  assert.equal(after.providerMessageId, null);
  assert.equal(after.sentAt, null);
  assert.equal(after.ownerToken, null);
  assert.equal(after.leaseUntil, null);
  assert.equal(after.nextAttemptAt, null);
  assert.equal(after.lastErrorCode, 'provider_unavailable');
  assert.equal(validateCanonicalNotificationOutbox(after, { TimestampClass: TestTimestamp }), true);
});

test('W3. production success writer produces canonical sent document satisfying chronology', async () => {
  const startMs = 1_000_000;
  const finishMs = 1_005_000;
  let currentMs = startMs;
  const { manager, db, eventId } = setupHarness({
    nowMs: startMs,
    outboxPatch: {
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: TestTimestamp.fromMillis(startMs),
      createdAt: TestTimestamp.fromMillis(startMs - 5000),
      updatedAt: TestTimestamp.fromMillis(startMs - 5000),
    },
    whatsappMock: {
      sendText: async () => {
        currentMs = finishMs;
        return { messageId: 'wamid.success_123' };
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.finalized, true);
  assert.equal(res.status, 'sent');
  assert.equal(res.messageId, 'wamid.success_123');

  const after = db.read('notification_outbox', eventId);
  assert.equal(after.state, 'sent');
  assert.equal(after.attemptCount, 1);
  assert.equal(after.providerMessageId, 'wamid.success_123');
  assert.equal(after.lastErrorCode, null);
  assert.equal(after.ownerToken, null);
  assert.equal(after.leaseUntil, null);
  assert.equal(after.nextAttemptAt, null);
  assert.ok(after.sentAt !== null);
  assert.ok(after.updatedAt !== null);

  // Exact chronology: createdAt <= sentAt <= updatedAt
  assert.ok(after.createdAt.toMillis() <= after.sentAt.toMillis());
  assert.ok(after.sentAt.toMillis() <= after.updatedAt.toMillis());
  assert.equal(validateCanonicalNotificationOutbox(after, { TimestampClass: TestTimestamp }), true);
});

// ============================================================================
// 6. FENCING & WINNER PRESERVATION
// ============================================================================

test('F1. Stale finalizer losing lease to second worker is fenced and does not overwrite', async () => {
  const nowMs = 1_000_000;
  const { db, jobId, eventId } = setupHarness({ nowMs });

  let worker2Called = false;
  const customWhatsApp = {
    sendText: async () => {
      // Simulate Worker 1 paused while Worker 2 reclaims and finalizes
      if (!worker2Called) {
        worker2Called = true;
        const worker2Manager = createNotificationDeliveryManager({
          db,
          whatsapp: { sendText: async () => ({ messageId: 'wamid.WINNER2' }) },
          TimestampClass: TestTimestamp,
          now: () => new Date(nowMs + 70000), // after 60s lease expired
        });
        await worker2Manager.deliverNotification(eventId);
      }
      return { messageId: 'wamid.STALE1' };
    },
  };

  const worker1Manager = createNotificationDeliveryManager({
    db,
    whatsapp: customWhatsApp,
    TimestampClass: TestTimestamp,
    now: () => new Date(nowMs),
  });

  const res1 = await worker1Manager.deliverNotification(eventId);
  assert.equal(res1.finalized, true); // Worker 2's sent was preserved by finalizer
  assert.equal(res1.preserved, true);

  const finalDoc = db.read('notification_outbox', eventId);
  assert.equal(finalDoc.state, 'sent');
  assert.equal(finalDoc.providerMessageId, 'wamid.WINNER2'); // Worker 2's ID kept!
});

// ============================================================================
// 7. SCHEDULER & ANTI-STARVATION
// ============================================================================

test('S1. deliverPendingNotifications delivers due pending, retry_wait, and expired in_progress', async () => {
  const nowMs = 1_000_000;
  const at = TestTimestamp.fromMillis(nowMs);
  const { manager, db } = setupHarness({ nowMs });

  // 1. Due pending
  db.seed('notification_outbox', 'job_in_progress:j1', {
    eventId: 'job_in_progress:j1',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j1',
    channel: 'whatsapp',
    recipientKey: 'customer:j1',
    payloadVersion: 1,
    payload: { jobId: 'j1', jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  });
  db.seed('jobs', 'j1', { jobId: 'j1', customerPhone: '+919876543210', status: 'in_progress' });

  // 2. Due retry_wait
  db.seed('notification_outbox', 'job_completed:j2', {
    eventId: 'job_completed:j2',
    eventType: 'job_completed',
    resourceType: 'job',
    resourceId: 'j2',
    channel: 'whatsapp',
    recipientKey: 'customer:j2',
    payloadVersion: 1,
    payload: { jobId: 'j2', jobStatus: 'completed', refundAmountPaise: null },
    state: 'retry_wait',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    attemptCount: 1,
    providerMessageId: null,
    lastErrorCode: 'provider_unavailable',
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  });
  db.seed('jobs', 'j2', { jobId: 'j2', customerPhone: '+919876543210', status: 'completed' });

  // 3. Expired in_progress
  db.seed('notification_outbox', 'job_cancelled_customer:j3', {
    eventId: 'job_cancelled_customer:j3',
    eventType: 'job_cancelled_customer',
    resourceType: 'job',
    resourceId: 'j3',
    channel: 'whatsapp',
    recipientKey: 'customer:j3',
    payloadVersion: 1,
    payload: { jobId: 'j3', jobStatus: 'cancelled_customer', refundAmountPaise: null },
    state: 'in_progress',
    ownerToken: 'stale_owner',
    leaseUntil: TestTimestamp.fromMillis(nowMs - 5000), // expired
    nextAttemptAt: null,
    attemptCount: 1,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  });
  db.seed('jobs', 'j3', { jobId: 'j3', customerPhone: '+919876543210', status: 'cancelled_customer' });

  const summary = await manager.deliverPendingNotifications({ batchSize: 10 });
  assert.equal(summary.delivered >= 3, true);

  assert.equal(db.read('notification_outbox', 'job_in_progress:j1').state, 'sent');
  assert.equal(db.read('notification_outbox', 'job_completed:j2').state, 'sent');
  assert.equal(db.read('notification_outbox', 'job_cancelled_customer:j3').state, 'sent');
});

test('S2. Poisoned malformed doc at head of query does not starve healthy subsequent documents', async () => {
  const nowMs = 1_000_000;
  const at = TestTimestamp.fromMillis(nowMs);
  const { manager, db } = setupHarness({ nowMs });

  // Poisoned document at head: invalid missing root keys
  db.seed('notification_outbox', 'job_accepted:j_bad:o1', {
    eventId: 'job_accepted:j_bad:o1',
    eventType: 'job_accepted',
    state: 'pending',
    nextAttemptAt: at,
    // missing all other required fields
  });

  // Valid healthy document behind it
  db.seed('notification_outbox', 'job_in_progress:j_good', {
    eventId: 'job_in_progress:j_good',
    eventType: 'job_in_progress',
    resourceType: 'job',
    resourceId: 'j_good',
    channel: 'whatsapp',
    recipientKey: 'customer:j_good',
    payloadVersion: 1,
    payload: { jobId: 'j_good', jobStatus: 'in_progress', refundAmountPaise: null },
    state: 'pending',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: at,
    attemptCount: 0,
    providerMessageId: null,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    sentAt: null,
  });
  db.seed('jobs', 'j_good', { jobId: 'j_good', customerPhone: '+919876543210', status: 'in_progress' });

  const summary = await manager.deliverPendingNotifications({ batchSize: 5 });
  assert.equal(summary.delivered >= 1, true);

  // Good document was delivered successfully
  assert.equal(db.read('notification_outbox', 'job_in_progress:j_good').state, 'sent');
  // Poisoned document remained untouched (fail-closed)
  assert.equal(db.read('notification_outbox', 'job_accepted:j_bad:o1').state, 'pending');
});

// ============================================================================
// 8. REFUND_CONFIRMED NON-INTERFERENCE & IDENTITY VALIDATION
// ============================================================================

test('R1. refund_confirmed delivery reads Stage 9 money state without mutating jobs or refund_requests', async () => {
  const nowMs = 1_000_000;
  const jobId = 'job_1';
  const amountPaise = 25000;
  const { job, refund } = makeCanonicalRefundPair(jobId, amountPaise, nowMs);

  const { manager, db, calls } = setupHarness({
    nowMs,
    jobPatch: job,
    outboxPatch: {
      eventType: 'refund_confirmed',
      eventId: `refund_confirmed:${jobId}`,
      resourceType: 'refund_request',
      resourceId: jobId,
      recipientKey: `customer:${jobId}`,
      payload: { jobId, jobStatus: 'cancelled_system', refundAmountPaise: amountPaise },
    },
  });

  db.seed('jobs', jobId, job);
  db.seed('refund_requests', jobId, refund);

  const jobBefore = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
  const refundBefore = JSON.parse(JSON.stringify(db.read('refund_requests', jobId)));

  const res = await manager.deliverNotification(`refund_confirmed:${jobId}`);
  assert.equal(res.status, 'sent');
  assert.equal(res.finalized, true);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].to, '+919876543210');
  assert.equal(calls.sends[0].text, 'A refund of INR 250.00 for booking job_1 has been processed to your original payment method.');

  const jobAfter = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
  const refundAfter = JSON.parse(JSON.stringify(db.read('refund_requests', jobId)));

  // Strictly unchanged
  assert.deepEqual(jobBefore, jobAfter);
  assert.deepEqual(refundBefore, refundAfter);

  // Only outbox mutated
  const outboxAfter = db.read('notification_outbox', `refund_confirmed:${jobId}`);
  assert.equal(outboxAfter.state, 'sent');
  assert.equal(outboxAfter.lastErrorCode, null);
  assert.match(outboxAfter.providerMessageId, /^wamid\./);
  assert.equal(validateCanonicalNotificationOutbox(outboxAfter, { TimestampClass: TestTimestamp }), true);
});

test('R2. refund_confirmed delivery with contradictory job money fails closed with internal_error and zero HTTP', async () => {
  const nowMs = 1_000_000;
  const jobId = 'job_1';
  const { job, refund } = makeCanonicalRefundPair(jobId, 10000, nowMs);

  const { manager, db, calls } = setupHarness({
    nowMs,
    jobPatch: job,
    outboxPatch: {
      eventType: 'refund_confirmed',
      eventId: `refund_confirmed:${jobId}`,
      resourceType: 'refund_request',
      resourceId: jobId,
      recipientKey: `customer:${jobId}`,
      payload: { jobId, jobStatus: 'cancelled_system', refundAmountPaise: 99999 }, // Contradiction!
    },
  });

  db.seed('jobs', jobId, job);
  db.seed('refund_requests', jobId, refund);

  const jobBefore = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
  const refundBefore = JSON.parse(JSON.stringify(db.read('refund_requests', jobId)));

  const res = await manager.deliverNotification(`refund_confirmed:${jobId}`);
  assert.equal(res.status, 'failed_terminal');
  assert.equal(res.lastErrorCode, 'internal_error');
  assert.equal(calls.sends.length, 0);

  const jobAfter = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
  const refundAfter = JSON.parse(JSON.stringify(db.read('refund_requests', jobId)));
  assert.deepEqual(jobBefore, jobAfter);
  assert.deepEqual(refundBefore, refundAfter);

  const outboxAfter = db.read('notification_outbox', `refund_confirmed:${jobId}`);
  assert.equal(outboxAfter.state, 'failed_terminal');
  assert.equal(outboxAfter.lastErrorCode, 'internal_error');
  assert.equal(outboxAfter.providerMessageId, null);
  assert.equal(validateCanonicalNotificationOutbox(outboxAfter, { TimestampClass: TestTimestamp }), true);
});

test('R3. Stage 10 refund identity matrix (cases A through J)', async () => {
  const nowMs = 1_000_000;
  const jobId = 'job_matrix';
  const amountPaise = 10000;

  const matrix = [
    {
      name: 'A. Fully canonical Stage9 projection',
      mutate: () => {},
      expectValid: true,
    },
    {
      name: 'B. job.razorpayRefundId != refund_request.razorpayRefundId',
      mutate: ({ job }) => { job.razorpayRefundId = 'rfnd_Contradictory'; },
      expectValid: false,
    },
    {
      name: 'C. job.razorpayPaymentId != refund_request.razorpayPaymentId',
      mutate: ({ job }) => { job.razorpayPaymentId = 'pay_Contradictory'; },
      expectValid: false,
    },
    {
      name: 'D. refund_request amount != job booking/refund amount',
      mutate: ({ refund }) => { refund.amountPaise = 5000; },
      expectValid: false,
    },
    {
      name: 'E. outbox refundAmountPaise != canonical refund amount',
      mutate: ({ outboxDoc }) => { outboxDoc.payload.refundAmountPaise = 5000; },
      expectValid: false,
    },
    {
      name: 'F. refund request missing',
      mutate: ({ deleteRefund }) => { deleteRefund(); },
      expectValid: false,
    },
    {
      name: 'G. refund request not confirmed',
      mutate: ({ refund }) => {
        refund.state = 'submitted';
        refund.confirmedAt = null;
        refund.reconciliationNextAttemptAt = TestTimestamp.fromMillis(nowMs);
      },
      expectValid: false,
    },
    {
      name: 'H. job refund projection not confirmed/canonical',
      mutate: ({ job }) => {
        job.refundState = 'submitted';
        job.refundConfirmedAt = null;
        job.refundedAmountPaise = null;
      },
      expectValid: false,
    },
    {
      name: 'I. wrong refund request identity / operation binding',
      mutate: ({ refund }) => {
        refund.jobId = 'other_job';
        refund.operationId = 'other_job';
      },
      expectValid: false,
    },
    {
      name: 'J. malformed confirmed refund request',
      mutate: ({ refund }) => {
        refund.confirmedAt = null; // missing required confirmedAt
      },
      expectValid: false,
    },
  ];

  for (const tc of matrix) {
    const { job, refund } = makeCanonicalRefundPair(jobId, amountPaise, nowMs);
    const eventId = `refund_confirmed:${jobId}`;
    const outboxDoc = {
      eventId,
      eventType: 'refund_confirmed',
      resourceType: 'refund_request',
      resourceId: jobId,
      channel: 'whatsapp',
      recipientKey: `customer:${jobId}`,
      payloadVersion: 1,
      payload: { jobId, jobStatus: 'cancelled_system', refundAmountPaise: amountPaise },
      state: 'pending',
      attemptCount: 0,
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: TestTimestamp.fromMillis(nowMs),
      providerMessageId: null,
      lastErrorCode: null,
      sentAt: null,
      createdAt: TestTimestamp.fromMillis(nowMs - 60000),
      updatedAt: TestTimestamp.fromMillis(nowMs - 10000),
    };

    let refundExists = true;
    tc.mutate({
      job,
      refund,
      outboxDoc,
      deleteRefund: () => { refundExists = false; },
    });

    let calls = 0;
    const db = new FakeFirestore();
    db.seed('jobs', jobId, job);
    if (refundExists) {
      db.seed('refund_requests', jobId, refund);
    }
    db.seed('notification_outbox', eventId, outboxDoc);

    const jobBefore = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
    const refundBefore = refundExists ? JSON.parse(JSON.stringify(db.read('refund_requests', jobId))) : null;

    const manager = createNotificationDeliveryManager({
      db,
      whatsapp: {
        sendText: async () => {
          calls++;
          return { messageId: 'wamid.matrixTest' };
        },
      },
      TimestampClass: TestTimestamp,
      now: () => new Date(nowMs),
      env: {
        WHATSAPP_ACCESS_TOKEN: 'valid_token',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_GRAPH_API_VERSION: 'v21.0',
      },
    });

    const res = await manager.deliverNotification(eventId);

    const jobAfter = JSON.parse(JSON.stringify(db.read('jobs', jobId)));
    const refundAfter = refundExists ? JSON.parse(JSON.stringify(db.read('refund_requests', jobId))) : null;

    // Jobs and refund_requests are NEVER mutated
    assert.deepEqual(jobBefore, jobAfter, `${tc.name}: job mutated`);
    assert.deepEqual(refundBefore, refundAfter, `${tc.name}: refund mutated`);

    const outboxAfter = db.read('notification_outbox', eventId);

    if (tc.expectValid) {
      assert.equal(res.status, 'sent', `${tc.name}: expected status sent`);
      assert.equal(calls, 1, `${tc.name}: expected 1 provider call`);
      assert.equal(outboxAfter.state, 'sent', `${tc.name}: expected outbox sent`);
      assert.equal(validateCanonicalNotificationOutbox(outboxAfter, { TimestampClass: TestTimestamp }), true);
    } else {
      assert.notEqual(res.status, 'sent', `${tc.name}: must NOT be sent`);
      assert.equal(calls, 0, `${tc.name}: must have 0 provider calls`);
      assert.equal(outboxAfter.state, 'failed_terminal', `${tc.name}: expected failed_terminal`);
      assert.equal(outboxAfter.lastErrorCode, 'internal_error', `${tc.name}: expected internal_error`);
      assert.equal(outboxAfter.providerMessageId, null, `${tc.name}: providerMessageId must be null`);
      assert.equal(validateCanonicalNotificationOutbox(outboxAfter, { TimestampClass: TestTimestamp }), true);

      // Cross-check that Stage 9 projection validator also rejects contradictory projection
      if (refundExists) {
        const s9Valid = s9.validateJobRefundProjection(job, refund, { TimestampClass: TestTimestamp, nowMs });
        if (tc.name.includes('job.') || tc.name.includes('refund_request') || tc.name.includes('job refund')) {
          assert.equal(s9Valid, false, `${tc.name}: Stage 9 validator must reject contradictory projection`);
        }
      }
    }
  }
});

test('R4. End-to-end integration: actual Stage 9 reconciler output to Stage 10 delivery and Astra contradiction reproduction', async () => {
  const nowMs = 1_000_000;
  const jobId = 'reconcile_integration_job';
  const paymentId = 'pay_Reconciled123';
  const refundId = 'rfnd_Reconciled123';
  const amountPaise = 10000;

  const refund = {
    operationId: jobId,
    jobId,
    razorpayPaymentId: paymentId,
    amountPaise,
    reason: 'no_driver_found',
    providerIdempotencyKey: 'refund_no_driver_found_' + jobId,
    providerRequestHash: crypto.createHash('sha256').update(JSON.stringify({ paymentId, amount: amountPaise })).digest('hex'),
    state: 'submitted',
    ownerToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    reconciliationNextAttemptAt: TestTimestamp.fromMillis(nowMs),
    reconciliationAttempts: 0,
    razorpayRefundId: refundId,
    confirmationSource: null,
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: TestTimestamp.fromMillis(nowMs - 60000),
    updatedAt: TestTimestamp.fromMillis(nowMs - 30000),
    submittedAt: TestTimestamp.fromMillis(nowMs - 30000),
    confirmedAt: null,
  };

  const job = {
    status: 'cancelled_system',
    dispatchState: 'closed',
    cancelledBy: 'system',
    cancellationReason: 'no_driver_found',
    cancelledAt: TestTimestamp.fromMillis(nowMs - 60000),
    refundRequestId: jobId,
    refundState: 'submitted',
    refundNextAttemptAt: TestTimestamp.fromMillis(nowMs),
    razorpayRefundId: refundId,
    refundConfirmedAt: null,
    refundedAmountPaise: null,
    bookingFeePaise: amountPaise,
    razorpayPaymentId: paymentId,
    paymentConfirmedAt: TestTimestamp.fromMillis(nowMs - 120000),
    customerPhone: '+919876543210',
    createdAt: TestTimestamp.fromMillis(nowMs - 180000),
    updatedAt: TestTimestamp.fromMillis(nowMs - 30000),
  };

  // Step 1: Stage 9 reconciler runs and confirms refund
  const db = new FakeFirestore();
  db.seed('jobs', jobId, job);
  db.seed('refund_requests', jobId, refund);

  let razorpayLookups = 0;
  const producer = s9.createNoDriverRefundManager({
    db,
    TimestampClass: TestTimestamp,
    now: () => nowMs,
    razorpayClient: {
      assertConfigured() {},
      getRefund: async args => {
        razorpayLookups++;
        assert.equal(args.paymentId, paymentId);
        assert.equal(args.refundId, refundId);
        return {
          id: refundId,
          entity: 'refund',
          amount: amountPaise,
          currency: 'INR',
          payment_id: paymentId,
          status: 'processed',
        };
      },
    },
  });

  const confirmation = await producer.reconcileSubmittedRefund(jobId);
  assert.equal(confirmation.status, 'confirmed');
  assert.equal(razorpayLookups, 1);

  const eventId = `refund_confirmed:${jobId}`;
  const outboxProduced = db.read('notification_outbox', eventId);
  assert.ok(outboxProduced, 'Stage 9 produced outbox doc');
  assert.equal(validateCanonicalNotificationOutbox(outboxProduced, { TimestampClass: TestTimestamp }), true);
  assert.equal(s9.validateRefundConfirmedOutbox(outboxProduced, { jobId, amountPaise, TimestampClass: TestTimestamp }), true);

  // Step 2: Normal Stage 10 delivery succeeds on actual Stage 9 output
  let deliveredCalls = 0;
  let deliveredText = null;
  const manager = createNotificationDeliveryManager({
    db,
    whatsapp: {
      sendText: async (phone, text) => {
        deliveredCalls++;
        deliveredText = text;
        return { messageId: 'wamid.reconcileTest' };
      },
    },
    TimestampClass: TestTimestamp,
    now: () => new Date(nowMs),
    env: {
      WHATSAPP_ACCESS_TOKEN: 'valid_token',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.status, 'sent');
  assert.equal(deliveredCalls, 1);
  assert.equal(deliveredText, 'A refund of INR 100.00 for booking reconcile_integration_job has been processed to your original payment method.');

  const outboxSent = db.read('notification_outbox', eventId);
  assert.equal(outboxSent.state, 'sent');
  assert.equal(validateCanonicalNotificationOutbox(outboxSent, { TimestampClass: TestTimestamp }), true);

  // Step 3: Reproduce Astra contradiction: mutate ONLY jobs/{jobId}.razorpayRefundId
  const db2 = new FakeFirestore();
  // Clone state from after reconciliation, but mutate only job.razorpayRefundId
  const confirmedJob = db.read('jobs', jobId);
  const confirmedRefund = db.read('refund_requests', jobId);
  confirmedJob.razorpayRefundId = 'rfnd_ContradictoryAstra';

  db2.seed('jobs', jobId, confirmedJob);
  db2.seed('refund_requests', jobId, confirmedRefund);
  // Fresh pending outbox
  db2.seed('notification_outbox', eventId, outboxProduced);

  const jobBeforeContradiction = JSON.parse(JSON.stringify(db2.read('jobs', jobId)));
  const refundBeforeContradiction = JSON.parse(JSON.stringify(db2.read('refund_requests', jobId)));

  // Committed Stage 9 validator rejects
  assert.equal(s9.validateJobRefundProjection(confirmedJob, confirmedRefund, { TimestampClass: TestTimestamp, nowMs }), false);

  let contradictoryCalls = 0;
  const manager2 = createNotificationDeliveryManager({
    db: db2,
    whatsapp: {
      sendText: async () => {
        contradictoryCalls++;
        throw new Error('Should not call provider');
      },
    },
    TimestampClass: TestTimestamp,
    now: () => new Date(nowMs),
    env: {
      WHATSAPP_ACCESS_TOKEN: 'valid_token',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
      WHATSAPP_GRAPH_API_VERSION: 'v21.0',
    },
  });

  const contradictionRes = await manager2.deliverNotification(eventId);
  assert.equal(contradictionRes.status, 'failed_terminal');
  assert.equal(contradictionRes.lastErrorCode, 'internal_error');
  assert.equal(contradictoryCalls, 0);

  // Jobs and refund_requests strictly unchanged
  assert.deepEqual(JSON.parse(JSON.stringify(db2.read('jobs', jobId))), jobBeforeContradiction);
  assert.deepEqual(JSON.parse(JSON.stringify(db2.read('refund_requests', jobId))), refundBeforeContradiction);

  const outboxFinal = db2.read('notification_outbox', eventId);
  assert.equal(outboxFinal.state, 'failed_terminal');
  assert.equal(outboxFinal.lastErrorCode, 'internal_error');
  assert.equal(outboxFinal.providerMessageId, null);
  assert.equal(validateCanonicalNotificationOutbox(outboxFinal, { TimestampClass: TestTimestamp }), true);
});

test('R5. Read count and source access: refund_confirmed requires refund_requests read; non-refund events do NOT read refund_requests', async () => {
  const nowMs = 1_000_000;
  const jobId = 'read_test_job';
  const amountPaise = 10000;

  // Intercept collection reads
  function createTrackingDb() {
    const rawDb = new FakeFirestore();
    const reads = [];
    const origDoc = rawDb.doc.bind(rawDb);
    const origCollection = rawDb.collection.bind(rawDb);

    rawDb.doc = function(path) {
      reads.push(path);
      return origDoc(path);
    };

    rawDb.collection = function(colName) {
      const colRef = origCollection(colName);
      const origColDoc = colRef.doc.bind(colRef);
      colRef.doc = function(docId) {
        reads.push(`${colName}/${docId}`);
        return origColDoc(docId);
      };
      return colRef;
    };

    return { db: rawDb, reads };
  }

  // Part 1: refund_confirmed delivery MUST read refund_requests/{jobId}
  {
    const { db, reads } = createTrackingDb();
    const { job, refund } = makeCanonicalRefundPair(jobId, amountPaise, nowMs);
    const eventId = `refund_confirmed:${jobId}`;

    db.seed('jobs', jobId, job);
    db.seed('refund_requests', jobId, refund);
    db.seed('notification_outbox', eventId, {
      eventId,
      eventType: 'refund_confirmed',
      resourceType: 'refund_request',
      resourceId: jobId,
      channel: 'whatsapp',
      recipientKey: `customer:${jobId}`,
      payloadVersion: 1,
      payload: { jobId, jobStatus: 'cancelled_system', refundAmountPaise: amountPaise },
      state: 'pending',
      attemptCount: 0,
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: TestTimestamp.fromMillis(nowMs),
      providerMessageId: null,
      lastErrorCode: null,
      sentAt: null,
      createdAt: TestTimestamp.fromMillis(nowMs - 60000),
      updatedAt: TestTimestamp.fromMillis(nowMs - 10000),
    });

    const manager = createNotificationDeliveryManager({
      db,
      whatsapp: { sendText: async () => ({ messageId: 'wamid.readCountTest' }) },
      TimestampClass: TestTimestamp,
      now: () => new Date(nowMs),
      env: {
        WHATSAPP_ACCESS_TOKEN: 'valid_token',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_GRAPH_API_VERSION: 'v21.0',
      },
    });

    const res = await manager.deliverNotification(eventId);
    assert.equal(res.status, 'sent');

    const refundReads = reads.filter(p => p.startsWith('refund_requests/'));
    assert.ok(refundReads.length >= 1, 'Must read refund_requests for refund_confirmed');
    assert.equal(refundReads.includes(`refund_requests/${jobId}`), true);
  }

  // Part 2: Non-refund event types must NOT read refund_requests
  const nonRefundEvents = [
    { eventType: 'job_accepted', resourceType: 'job', status: 'accepted', offerId: 'off_1' },
    { eventType: 'job_in_progress', resourceType: 'job', status: 'in_progress' },
    { eventType: 'job_completed', resourceType: 'job', status: 'completed' },
    { eventType: 'job_cancelled_customer', resourceType: 'job', status: 'cancelled_customer' },
    { eventType: 'job_cancelled_system', resourceType: 'job', status: 'cancelled_system' },
  ];

  for (const item of nonRefundEvents) {
    const { db, reads } = createTrackingDb();
    const eventJobId = `job_${item.eventType}`;
    const eventId = item.eventType === 'job_accepted'
      ? `job_accepted:${eventJobId}:${item.offerId}`
      : `${item.eventType}:${eventJobId}`;

    db.seed('jobs', eventJobId, {
      jobId: eventJobId,
      status: item.status,
      customerPhone: '+919876543210',
    });

    const payload = { jobId: eventJobId, jobStatus: item.status, refundAmountPaise: null };

    db.seed('notification_outbox', eventId, {
      eventId,
      eventType: item.eventType,
      resourceType: item.resourceType,
      resourceId: eventJobId,
      channel: 'whatsapp',
      recipientKey: `customer:${eventJobId}`,
      payloadVersion: 1,
      payload,
      state: 'pending',
      attemptCount: 0,
      ownerToken: null,
      leaseUntil: null,
      nextAttemptAt: TestTimestamp.fromMillis(nowMs),
      providerMessageId: null,
      lastErrorCode: null,
      sentAt: null,
      createdAt: TestTimestamp.fromMillis(nowMs - 60000),
      updatedAt: TestTimestamp.fromMillis(nowMs - 10000),
    });

    const manager = createNotificationDeliveryManager({
      db,
      whatsapp: { sendText: async () => ({ messageId: `wamid.${item.eventType}` }) },
      TimestampClass: TestTimestamp,
      now: () => new Date(nowMs),
      env: {
        WHATSAPP_ACCESS_TOKEN: 'valid_token',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        WHATSAPP_GRAPH_API_VERSION: 'v21.0',
      },
    });

    const res = await manager.deliverNotification(eventId);
    assert.equal(res.status, 'sent', `${item.eventType} delivery should succeed`);

    const refundReads = reads.filter(p => p.startsWith('refund_requests/'));
    assert.equal(refundReads.length, 0, `${item.eventType} must NOT read refund_requests`);
  }
});

// ============================================================================
// 9. EVENT TRIGGER FILTER
// ============================================================================

test('T1. shouldProcessNotificationCreated filters only valid pending created events', () => {
  assert.equal(shouldProcessNotificationCreated(null), false);
  assert.equal(shouldProcessNotificationCreated({}), false);
  assert.equal(shouldProcessNotificationCreated({ data: { exists: false } }), false);
  assert.equal(shouldProcessNotificationCreated({ data: { exists: true, data: () => ({ state: 'sent' }) } }), false);
  assert.equal(shouldProcessNotificationCreated({ data: { exists: true, data: () => ({ state: 'pending' }) } }), true);
});

test('T2. shouldProcessNotificationCreated verifies event.params.eventId matches data.eventId', () => {
  const matchingEvent = {
    params: { eventId: 'job_completed:job_123' },
    data: {
      exists: true,
      data: () => ({ eventId: 'job_completed:job_123', state: 'pending' }),
    },
  };
  assert.equal(shouldProcessNotificationCreated(matchingEvent), true);

  const mismatchEvent = {
    params: { eventId: 'unexpected_alias_id' },
    data: {
      exists: true,
      data: () => ({ eventId: 'job_completed:job_123', state: 'pending' }),
    },
  };
  assert.equal(shouldProcessNotificationCreated(mismatchEvent), false);

  const nonStringParamEvent = {
    params: { eventId: 12345 },
    data: {
      exists: true,
      data: () => ({ eventId: 'job_completed:job_123', state: 'pending' }),
    },
  };
  assert.equal(shouldProcessNotificationCreated(nonStringParamEvent), false);

  const missingDataEventId = {
    params: { eventId: 'job_completed:job_123' },
    data: {
      exists: true,
      data: () => ({ state: 'pending' }),
    },
  };
  assert.equal(shouldProcessNotificationCreated(missingDataEventId), false);
});

// ============================================================================
// 10. DOCUMENT-IDENTITY BINDING & VALIDATION TESTS
// ============================================================================

test('V1. validateCanonicalNotificationOutbox accepts expectedEventId and documentId matching eventId', () => {
  const { db } = setupHarness({ outboxPatch: { eventType: 'job_completed' } });
  const doc = db.data['notification_outbox']['job_completed:job_1'];
  assert.ok(doc);

  // Matching documentId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, documentId: 'job_completed:job_1' }), true);
  // Matching expectedEventId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, expectedEventId: 'job_completed:job_1' }), true);
  // Both matching
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, documentId: 'job_completed:job_1', expectedEventId: 'job_completed:job_1' }), true);

  // Mismatched documentId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, documentId: 'unexpected_doc_id' }), false);
  // Mismatched expectedEventId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, expectedEventId: 'unexpected_doc_id' }), false);
  // Non-string documentId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, documentId: 12345 }), false);
  // Empty documentId
  assert.equal(validateCanonicalNotificationOutbox(doc, { TimestampClass: TestTimestamp, documentId: '' }), false);
});

test('DIM-A. Document-Identity Matrix: Case A - Matching doc.id and stored eventId succeeds with 1 provider call', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: { eventType: 'job_completed', resourceId: 'job_dim_a' },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_a' };
      },
    },
  });

  const res = await manager.deliverNotification(eventId);
  assert.equal(res.claimed, true);
  assert.equal(res.status, 'sent');
  assert.equal(providerCalls, 1);
});

test('DIM-B. Document-Identity Matrix: Case B - Mismatched pending doc returns malformed with 0 provider calls and 0 writes', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: { eventType: 'job_completed', resourceId: 'job_dim_b' },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_b' };
      },
    },
  });

  // Seed canonical document at an alias/mismatched document ID
  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_b';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const beforeSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  const res = await manager.deliverNotification(aliasDocId);
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'malformed');
  assert.equal(providerCalls, 0, 'Zero provider calls on mismatched docId');

  // Verify document was NOT modified (0 writes)
  const afterSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(afterSnapshot, beforeSnapshot, 'Aliased document must be byte-for-byte unchanged');
  assert.notEqual(res.status, 'failed_terminal', 'Must NOT transition to failed_terminal');
});

test('DIM-C. Document-Identity Matrix: Case C - Mismatched retry_wait doc returns malformed with 0 provider calls and 0 writes', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      eventType: 'job_completed',
      resourceId: 'job_dim_c',
      state: 'retry_wait',
      attemptCount: 1,
      lastErrorCode: 'provider_unavailable',
      nextAttemptAt: TestTimestamp.fromMillis(nowMs - 1000),
    },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_c' };
      },
    },
  });

  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_c';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const beforeSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  const res = await manager.deliverNotification(aliasDocId);
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'malformed');
  assert.equal(providerCalls, 0);

  const afterSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(afterSnapshot, beforeSnapshot);
});

test('DIM-D. Document-Identity Matrix: Case D - Mismatched expired in_progress doc returns malformed with 0 provider calls and 0 writes', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      eventType: 'job_completed',
      resourceId: 'job_dim_d',
      state: 'in_progress',
      attemptCount: 1,
      ownerToken: 'old_worker',
      leaseUntil: TestTimestamp.fromMillis(nowMs - 5000),
    },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_d' };
      },
    },
  });

  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_d';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const beforeSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  const res = await manager.deliverNotification(aliasDocId);
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'malformed');
  assert.equal(providerCalls, 0);

  const afterSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(afterSnapshot, beforeSnapshot);
});

test('DIM-E. Document-Identity Matrix: Case E - Mismatched sent doc returns malformed (not sent) with 0 writes and 0 provider calls', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      eventType: 'job_completed',
      resourceId: 'job_dim_e',
      state: 'sent',
      attemptCount: 1,
      providerMessageId: 'wamid.existing_sent',
      sentAt: TestTimestamp.fromMillis(nowMs - 10000),
      createdAt: TestTimestamp.fromMillis(nowMs - 60000),
      updatedAt: TestTimestamp.fromMillis(nowMs - 5000),
    },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_e' };
      },
    },
  });

  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_e';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const beforeSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  const res = await manager.deliverNotification(aliasDocId);
  // Absorbing state check MUST NOT short-circuit before document-identity check!
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'malformed', 'Must return malformed rather than absorbing sent');
  assert.equal(providerCalls, 0);

  const afterSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(afterSnapshot, beforeSnapshot);
});

test('DIM-F. Document-Identity Matrix: Case F - Mismatched failed_terminal doc returns malformed (not failed_terminal) with 0 writes and 0 provider calls', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      eventType: 'job_completed',
      resourceId: 'job_dim_f',
      state: 'failed_terminal',
      attemptCount: 5,
      lastErrorCode: 'recipient_unreachable',
      createdAt: TestTimestamp.fromMillis(nowMs - 60000),
      updatedAt: TestTimestamp.fromMillis(nowMs - 5000),
    },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_f' };
      },
    },
  });

  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_f';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const beforeSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  const res = await manager.deliverNotification(aliasDocId);
  // Absorbing state check MUST NOT short-circuit before document-identity check!
  assert.equal(res.claimed, false);
  assert.equal(res.status, 'malformed', 'Must return malformed rather than absorbing failed_terminal');
  assert.equal(providerCalls, 0);

  const afterSnapshot = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(afterSnapshot, beforeSnapshot);
});

test('DIM-G. Document-Identity Matrix: Case G - Duplicate doc delivery: canonical delivers, alias rejected as malformed with 1 total provider call', async () => {
  const nowMs = 1_000_000;
  let providerCalls = 0;
  const { db, manager, eventId } = setupHarness({
    nowMs,
    outboxPatch: {
      eventType: 'job_completed',
      resourceId: 'job_dim_g',
    },
    whatsappMock: {
      sendText: async () => {
        providerCalls++;
        return { messageId: 'wamid.dim_g_' + providerCalls };
      },
    },
  });

  const canonicalDoc = db.data['notification_outbox'][eventId];
  const aliasDocId = 'unexpected_alias_g';
  db.seed('notification_outbox', aliasDocId, JSON.parse(JSON.stringify(canonicalDoc)));
  const aliasBefore = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));

  // 1. Deliver canonical
  const canonicalRes = await manager.deliverNotification(eventId);
  assert.equal(canonicalRes.status, 'sent');
  assert.equal(providerCalls, 1);

  // 2. Deliver alias
  const aliasRes = await manager.deliverNotification(aliasDocId);
  assert.equal(aliasRes.claimed, false);
  assert.equal(aliasRes.status, 'malformed');
  assert.equal(providerCalls, 1, 'Total provider calls must remain 1');

  // Alias doc untouched
  const aliasAfter = JSON.parse(JSON.stringify(db.data['notification_outbox'][aliasDocId]));
  assert.deepStrictEqual(aliasAfter, aliasBefore);

  // 3. Repeated delivery of alias
  const aliasRepeat = await manager.deliverNotification(aliasDocId);
  assert.equal(aliasRepeat.claimed, false);
  assert.equal(aliasRepeat.status, 'malformed');
  assert.equal(providerCalls, 1);
});
