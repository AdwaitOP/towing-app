'use strict';

const { FakeFirestore, FakeTimestamp, createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWhatsAppWebhook,
} = require('../../../firebase/functions/src/messaging/whatsappWebhook');

const phone = '+919876543210';
const now = 1_800_000_000_000;

function locationMessage(id, latitude, longitude) {
  return { id, from: '919876543210', type: 'location', location: { latitude, longitude } };
}

function textMessage(id, body, from = '919876543210') {
  return { id, from, type: 'text', text: { body } };
}

function harness(options = {}) {
  const db = options.db || new FakeFirestore();
  const sent = [];
  let sendFailures = options.sendFailures || 0;
  const jobCalls = [];
  const webhook = createWhatsAppWebhook({
    db,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: {
      WHATSAPP_VERIFY_TOKEN: 'verify-token',
      WHATSAPP_APP_SECRET: 'app-secret',
    },
    verifySignatureFn: options.signatureFn || (() => true),
    jobs: {
      createJobAndQuote: async (...args) => {
        jobCalls.push(args);
        if (options.jobImpl) return options.jobImpl(db, ...args);
        return {
          jobId: args[0], bookingFeePaise: 50000, estimatedFarePaise: 250000,
          razorpayPaymentLinkUrl: 'https://rzp.io/i/job',
        };
      },
    },
    whatsapp: {
      sendText: async (...args) => {
        sent.push(args);
        if (options.onSend) await options.onSend(db, ...args);
        if (sendFailures > 0) { sendFailures -= 1; throw new Error('Meta send failed'); }
        return { messageId: `out-${sent.length}` };
      },
    },
    razorpay: options.razorpay || {
      getPaymentLinksByReferenceId: async () => [],
      getPaymentLink: async () => { throw new Error('not configured'); },
      cancelPaymentLink: async () => { throw new Error('not configured'); },
    },
  });
  return { db, webhook, sent, jobCalls, allowSends: () => { sendFailures = 0; } };
}

test('Meta GET verification requires exact configured token and challenge', async () => {
  const setup = harness();
  const accepted = createMockResponse();
  await setup.webhook.handleWhatsAppWebhook({
    method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token', 'hub.challenge': 'challenge' },
  }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body, 'challenge');

  const denied = createMockResponse();
  await setup.webhook.handleWhatsAppWebhook({
    method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'challenge' },
  }, denied);
  assert.equal(denied.statusCode, 403);
});

test('POST verifies raw-body signature before inspecting malformed payload', async () => {
  let signatureArguments;
  const setup = harness({ signatureFn: (...args) => { signatureArguments = args; return false; } });
  const rawBody = Buffer.from('not-json-but-express-body-exists');
  const res = createMockResponse();
  await setup.webhook.handleWhatsAppWebhook({
    method: 'POST', rawBody, body: null, headers: { 'x-hub-signature-256': 'bad' },
  }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(signatureArguments[0], rawBody);
  assert.equal(signatureArguments[3], 'sha256=');
  assert.equal(setup.sent.length, 0);
});

test('status-only payload is acknowledged without conversation side effects', async () => {
  const setup = harness();
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.outbound', status: 'delivered' }] } }] }],
  };
  const res = createMockResponse();
  await setup.webhook.handleWhatsAppWebhook({
    method: 'POST', rawBody: Buffer.from(JSON.stringify(body)), body,
    headers: { 'x-hub-signature-256': 'valid' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(setup.sent.length, 0);
});

test('multiple messages are handled and duplicate delivery does not repeat replies', async () => {
  const setup = harness();
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [
      textMessage('wamid.1', 'hello'),
      textMessage('wamid.2', 'hello', '919999999999'),
    ] } }] }],
  };
  const invoke = async () => {
    const res = createMockResponse();
    await setup.webhook.handleWhatsAppWebhook({
      method: 'POST', rawBody: Buffer.from(JSON.stringify(body)), body,
      headers: { 'x-hub-signature-256': 'valid' },
    }, res);
    return res;
  };
  assert.equal((await invoke()).statusCode, 200);
  assert.equal(setup.sent.length, 2);
  assert.equal((await invoke()).statusCode, 200);
  assert.equal(setup.sent.length, 2);
});

test('state machine persists pickup, destination, job ID, and quote in order', async () => {
  const setup = harness({
    jobImpl: async (db, jobId, customerPhone, pickup, destination, truckType, channel) => {
      const session = db.read('whatsapp_sessions', phone);
      assert.equal(session.jobId, jobId);
      assert.equal(session.state, 4);
      assert.equal(session.pendingReply.kind, 'job_quote');
      assert.deepEqual([customerPhone, pickup, destination, truckType, channel], [
        phone, { lat: 19.03, lng: 73.02 }, { lat: 19.08, lng: 72.99 }, 'flatbed', 'whatsapp',
      ]);
      return { jobId, bookingFeePaise: 50000, estimatedFarePaise: 250000, razorpayPaymentLinkUrl: 'https://rzp.io/i/job' };
    },
  });
  await setup.webhook.processMessage(phone, locationMessage('m1', 19.03, 73.02), 'm1', 'owner-1');
  await setup.webhook.processMessage(phone, locationMessage('m2', 19.08, 72.99), 'm2', 'owner-2');
  await setup.webhook.processMessage(phone, textMessage('m3', '1'), 'm3', 'owner-3');
  const session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 5);
  assert.match(session.jobId, /^auto-id-/);
  assert.equal(session.lastProcessedMessageId, 'm3');
  assert.equal(session.pendingReply, null);
  assert.equal(session.processingOwnerToken, null);
  assert.equal(setup.jobCalls.length, 1);
  assert.match(setup.sent.at(-1)[1], /INR 2500\.00/);
  assert.match(setup.sent.at(-1)[1], /INR 500\.00/);
});

test('job failure keeps recoverable pending work and retry reuses the same preallocated ID', async () => {
  let failures = 1;
  const setup = harness({
    jobImpl: async (_db, jobId) => {
      if (failures-- > 0) throw new Error('Razorpay unavailable');
      return { jobId, bookingFeePaise: 50000, estimatedFarePaise: 250000, razorpayPaymentLinkUrl: 'https://rzp.io/i/job' };
    },
  });
  setup.db.seed('whatsapp_sessions', phone, {
    phoneNumber: phone, state: 3, pickupCoords: { lat: 19, lng: 73 },
    destCoords: { lat: 19.1, lng: 73.1 }, requestedTruckType: null, jobId: null,
    pendingReply: null, lastProcessedMessageId: null,
  });
  await assert.rejects(
    setup.webhook.processMessage(phone, textMessage('m3', 'flatbed'), 'm3', 'owner-1'),
    /Razorpay unavailable/
  );
  const preallocated = setup.db.read('whatsapp_sessions', phone).jobId;
  assert.equal(setup.db.read('whatsapp_sessions', phone).pendingReply.kind, 'job_quote');
  await setup.webhook.processMessage(phone, textMessage('m3', 'flatbed'), 'm3', 'owner-2');
  assert.equal(setup.jobCalls[0][0], preallocated);
  assert.equal(setup.jobCalls[1][0], preallocated);
  assert.equal(setup.db.read('whatsapp_sessions', phone).state, 5);
});

test('failed outbound reply resumes without a second state advance', async () => {
  const setup = harness({ sendFailures: 1 });
  const message = locationMessage('m1', 19.03, 73.02);
  await assert.rejects(setup.webhook.processMessage(phone, message, 'm1', 'owner-1'), /Meta send failed/);
  let session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 2);
  assert.equal(session.pendingReply.messageId, 'm1');
  assert.equal(session.lastProcessedMessageId, null);
  setup.allowSends();
  await setup.webhook.processMessage(phone, message, 'm1', 'owner-2');
  session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 2);
  assert.equal(session.lastProcessedMessageId, 'm1');
  assert.equal(session.pendingReply, null);
});

test('outbound send is fenced by the current session owner and pending reply', async () => {
  let checked = false;
  const setup = harness({
    onSend: async db => {
      const session = db.read('whatsapp_sessions', phone);
      checked = true;
      assert.equal(session.processingMessageId, 'm1');
      assert.equal(session.processingOwnerToken, 'owner-1');
      assert.ok(session.processingLeaseUntil.toMillis() > now);
      assert.equal(session.pendingReply.messageId, 'm1');
    },
  });
  await setup.webhook.processMessage(phone, textMessage('m1', 'hello'), 'm1', 'owner-1');
  assert.equal(checked, true);
});

test('a newer input drains an old pending reply and is then processed rather than consumed', async () => {
  const setup = harness();
  setup.db.seed('whatsapp_sessions', phone, {
    phoneNumber: phone,
    state: 2,
    pickupCoords: { lat: 19, lng: 73 },
    destCoords: null,
    requestedTruckType: null,
    jobId: null,
    pendingReply: { kind: 'text', messageId: 'old-message', body: 'Please share destination.' },
    lastProcessedMessageId: null,
    processingMessageId: null,
    processingOwnerToken: null,
    processingLeaseUntil: null,
  });
  await setup.webhook.processMessage(
    phone, locationMessage('new-message', 19.1, 73.1), 'new-message', 'new-owner'
  );
  assert.equal(setup.sent.length, 2);
  assert.equal(setup.sent[0][1], 'Please share destination.');
  assert.match(setup.sent[1][1], /Which towing category/);
  const session = setup.db.read('whatsapp_sessions', phone);
  assert.equal(session.state, 3);
  assert.equal(session.lastProcessedMessageId, 'new-message');
  assert.deepEqual(session.destCoords, { lat: 19.1, lng: 73.1 });
  assert.equal(
    setup.db.read('processed_requests', 'meta:old-message').status,
    'completed'
  );
});

test('different active owner is rejected while an expired lease is reclaimable', async () => {
  const setup = harness();
  setup.db.seed('whatsapp_sessions', phone, {
    phoneNumber: phone, state: 1, pendingReply: null, lastProcessedMessageId: null,
    processingMessageId: 'active-message', processingOwnerToken: 'active-owner',
    processingLeaseUntil: FakeTimestamp.fromMillis(now + 1000),
  });
  await assert.rejects(
    setup.webhook.processMessage(phone, locationMessage('new', 0, 0), 'new', 'new-owner'),
    /active session lease/
  );
  assert.equal(setup.db.read('whatsapp_sessions', phone).processingOwnerToken, 'active-owner');
  setup.db.seed('whatsapp_sessions', phone, {
    ...setup.db.read('whatsapp_sessions', phone),
    processingLeaseUntil: FakeTimestamp.fromMillis(now - 1),
  });
  await setup.webhook.processMessage(phone, locationMessage('new', 0, 0), 'new', 'new-owner');
  assert.equal(setup.db.read('whatsapp_sessions', phone).lastProcessedMessageId, 'new');
});

test('lastProcessedMessageId prevents duplicate state advancement after outer-log crash', async () => {
  const setup = harness();
  setup.db.seed('whatsapp_sessions', phone, {
    phoneNumber: phone, state: 2, pickupCoords: { lat: 19, lng: 73 },
    lastProcessedMessageId: 'same-message', pendingReply: null,
  });
  await setup.webhook.processMessage(
    phone, locationMessage('same-message', 19.1, 73.1), 'same-message', 'new-owner'
  );
  assert.equal(setup.db.read('whatsapp_sessions', phone).state, 2);
  assert.equal(setup.sent.length, 0);
});
