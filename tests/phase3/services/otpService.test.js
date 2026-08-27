'use strict';

const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOtpService, OtpError } = require('../../../firebase/functions/src/services/otpService');

const phone = '+919876543210';
const policy = {
  otpExpirySeconds: 300,
  resendCooldownSeconds: 60,
  maxSendsPerWindow: 5,
  sendWindowSeconds: 900,
  blockDurationSeconds: 3600,
  maxVerificationAttempts: 5,
};
const otpTemplate = { templateName: 'driver_login_auth', languageCode: 'en_US' };

function harness(options = {}) {
  const db = new FakeFirestore();
  db.seed('business_config', 'main', {
    otpPolicy: { ...policy },
    whatsappOtpTemplate: { ...otpTemplate },
  });
  let now = options.now ?? 1_000_000;
  let challenge = 0;
  const calls = { hashes: [], verifies: [], sends: [], auth: [] };
  const cryptoOps = {
    generateOtp: () => '123456',
    hashOtp: async (otp, pepper) => {
      calls.hashes.push({ otp, pepper });
      return { hash: 'a'.repeat(128), salt: 'b'.repeat(32) };
    },
    verifyOtp: async (...args) => {
      calls.verifies.push(args);
      if (options.onVerify) return options.onVerify({ setNow: value => { now = value; } });
      return options.validOtp ?? true;
    },
  };
  const whatsapp = { sendAuthenticationTemplate: async (...args) => { calls.sends.push(args); } };
  const auth = options.auth || {
    getUserByPhoneNumber: async number => { calls.auth.push(['get', number]); return { uid: 'driver-1' }; },
    createUser: async input => { calls.auth.push(['create', input]); return { uid: 'driver-1' }; },
    createCustomToken: async uid => { calls.auth.push(['token', uid]); return 'custom-token'; },
  };
  const service = createOtpService({
    db,
    auth,
    TimestampClass: FakeTimestamp,
    now: () => now,
    env: { OTP_PEPPER: 'secret-pepper' },
    cryptoOps,
    whatsapp,
    randomUUID: () => `challenge-${++challenge}`,
  });
  return { db, service, calls, getNow: () => now, setNow: value => { now = value; }, whatsapp };
}

test('permitted send stores only a salted hash and configured five-minute expiry', async () => {
  const setup = harness();
  await setup.service.sendDriverOtp(phone);
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.challengeId, 'challenge-1');
  assert.equal(record.hash, 'a'.repeat(128));
  assert.equal(record.salt, 'b'.repeat(32));
  assert.equal(record.expiresAt.toMillis(), 1_300_000);
  assert.equal(record.sendWindowStartedAt.toMillis(), 1_000_000);
  assert.equal(record.sendCount, 1);
  assert.equal(record.attempts, 0);
  assert.equal(record.consumedAt, null);
  assert.equal(JSON.stringify(record).includes('123456'), false);
  assert.equal(setup.calls.sends[0][0], phone);
  assert.equal(setup.calls.sends[0][1], '123456');
  assert.deepEqual(setup.calls.sends[0][2], otpTemplate);
});

test('resend cooldown rejects without replacing the active challenge', async () => {
  const setup = harness();
  await setup.service.sendDriverOtp(phone);
  setup.setNow(setup.getNow() + 59_999);
  await assert.rejects(
    setup.service.sendDriverOtp(phone),
    error => error instanceof OtpError && error.code === 'OTP_RESEND_COOLDOWN'
  );
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.challengeId, 'challenge-1');
  assert.equal(record.sendCount, 1);
  assert.equal(setup.calls.sends.length, 1);
  assert.equal(setup.calls.hashes.length, 1);
});

test('an active send block rejects before OTP hashing', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    sendWindowStartedAt: FakeTimestamp.fromMillis(900_000),
    sendCount: 5,
    lastSentAt: FakeTimestamp.fromMillis(900_000),
    blockedUntil: FakeTimestamp.fromMillis(2_000_000),
  });
  await assert.rejects(
    setup.service.sendDriverOtp(phone),
    error => error instanceof OtpError && error.code === 'OTP_SEND_BLOCKED'
  );
  assert.equal(setup.calls.hashes.length, 0);
  assert.equal(setup.calls.sends.length, 0);
});

test('sixth send sets a one-hour block before returning 429', async () => {
  const setup = harness();
  for (let count = 1; count <= 5; count += 1) {
    if (count > 1) setup.setNow(setup.getNow() + 60_000);
    await setup.service.sendDriverOtp(phone);
  }
  setup.setNow(setup.getNow() + 60_000);
  const blockedAt = setup.getNow();
  await assert.rejects(
    setup.service.sendDriverOtp(phone),
    error => error instanceof OtpError && error.code === 'OTP_SEND_BLOCKED'
  );
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.sendCount, 5);
  assert.equal(record.blockedUntil.toMillis(), blockedAt + 3_600_000);
  assert.equal(record.challengeId, 'challenge-5');
  assert.equal(setup.calls.sends.length, 5);
});

test('expired block begins a fresh window and does not carry the old send count', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    sendWindowStartedAt: FakeTimestamp.fromMillis(1000),
    sendCount: 5,
    lastSentAt: FakeTimestamp.fromMillis(2000),
    blockedUntil: FakeTimestamp.fromMillis(1_000_000),
  });
  setup.setNow(1_000_000);
  await setup.service.sendDriverOtp(phone);
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.sendWindowStartedAt.toMillis(), 1_000_000);
  assert.equal(record.sendCount, 1);
  assert.equal(record.blockedUntil, null);
});

test('expired send window resets counters while resend replaces only challenge fields', async () => {
  const setup = harness();
  await setup.service.sendDriverOtp(phone);
  setup.setNow(setup.getNow() + 60_000);
  await setup.service.sendDriverOtp(phone);
  let record = setup.db.read('driver_otps', phone);
  assert.equal(record.challengeId, 'challenge-2');
  assert.equal(record.sendCount, 2);
  setup.setNow(record.sendWindowStartedAt.toMillis() + 900_000);
  await setup.service.sendDriverOtp(phone);
  record = setup.db.read('driver_otps', phone);
  assert.equal(record.challengeId, 'challenge-3');
  assert.equal(record.sendCount, 1);
  assert.equal(record.sendWindowStartedAt.toMillis(), setup.getNow());
});

test('resend clears stale verification metadata without erasing abuse counters', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    challengeId: 'old-challenge',
    hash: 'c'.repeat(128),
    salt: 'd'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(1_100_000),
    attempts: 3,
    consumedAt: FakeTimestamp.fromMillis(950_000),
    verifiedUid: 'old-driver-uid',
    lastSentAt: FakeTimestamp.fromMillis(900_000),
    sendWindowStartedAt: FakeTimestamp.fromMillis(900_000),
    sendCount: 2,
    blockedUntil: null,
  });
  await setup.service.sendDriverOtp(phone);
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.challengeId, 'challenge-1');
  assert.equal(record.attempts, 0);
  assert.equal(record.consumedAt, null);
  assert.equal(record.verifiedUid, null);
  assert.equal(record.sendCount, 3);
  assert.equal(record.sendWindowStartedAt.toMillis(), 900_000);
});

test('attempt 6 is rejected before scrypt and before increment', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 5, consumedAt: null,
  });
  await assert.rejects(
    setup.service.verifyDriverOtp(phone, '123456'),
    error => error instanceof OtpError && error.code === 'OTP_ATTEMPTS_EXCEEDED'
  );
  assert.equal(setup.calls.verifies.length, 0);
  assert.equal(setup.db.read('driver_otps', phone).attempts, 5);
});

test('successful verification increments once, consumes unchanged challenge, and returns custom token', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  assert.equal(await setup.service.verifyDriverOtp(phone, '123456'), 'custom-token');
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.attempts, 1);
  assert.equal(record.consumedAt.toMillis(), 1_000_000);
  assert.equal(record.verifiedUid, 'driver-1');
  assert.equal(setup.calls.verifies.length, 1);
  assert.deepEqual(setup.calls.auth, [
    ['get', phone], ['token', 'driver-1'],
  ]);
});

test('transaction 2 rechecks expiry after asynchronous scrypt', async () => {
  const setup = harness({
    onVerify: ({ setNow }) => { setNow(2_000_001); return true; },
  });
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  await assert.rejects(setup.service.verifyDriverOtp(phone, '123456'), /expired/);
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.attempts, 1);
  assert.equal(record.consumedAt, null);
});

test('a consumed challenge cannot be verified or scrypt-checked again', async () => {
  const setup = harness();
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  await setup.service.verifyDriverOtp(phone, '123456');
  await assert.rejects(setup.service.verifyDriverOtp(phone, '123456'), /consumed/);
  assert.equal(setup.calls.verifies.length, 1);
});

test('Firebase Auth user-not-found creates the user before token minting', async () => {
  const authCalls = [];
  const setup = harness({
    auth: {
      getUserByPhoneNumber: async () => {
        authCalls.push('get');
        const error = new Error('not found'); error.code = 'auth/user-not-found'; throw error;
      },
      createUser: async input => { authCalls.push(['create', input]); return { uid: 'new-driver' }; },
      createCustomToken: async uid => { authCalls.push(['token', uid]); return 'new-token'; },
    },
  });
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  assert.equal(await setup.service.verifyDriverOtp(phone, '123456'), 'new-token');
  assert.deepEqual(authCalls, ['get', ['create', { phoneNumber: phone }], ['token', 'new-driver']]);
});

test('OTP service fails closed when pepper or policy is absent', async () => {
  const setup = harness();
  const noPepper = createOtpService({
    db: setup.db,
    auth: {},
    TimestampClass: FakeTimestamp,
    now: () => 1_000_000,
    env: {},
    cryptoOps: {},
    whatsapp: {},
  });
  await assert.rejects(noPepper.sendDriverOtp(phone), /OTP_PEPPER/);
  setup.db.seed('business_config', 'main', {});
  await assert.rejects(setup.service.sendDriverOtp(phone), /policy/);
});

test('OTP send fails closed when the approved authentication template is missing or invalid', async () => {
  const missing = harness();
  missing.db.seed('business_config', 'main', { otpPolicy: { ...policy } });
  await assert.rejects(
    missing.service.sendDriverOtp(phone),
    error => error instanceof OtpError && error.code === 'OTP_TEMPLATE_MISSING'
  );
  assert.equal(missing.calls.hashes.length, 0);
  assert.equal(missing.calls.sends.length, 0);

  const invalid = harness();
  invalid.db.seed('business_config', 'main', {
    otpPolicy: { ...policy },
    whatsappOtpTemplate: { templateName: '', languageCode: '' },
  });
  await assert.rejects(
    invalid.service.sendDriverOtp(phone),
    error => error instanceof OtpError && error.code === 'OTP_TEMPLATE_INVALID'
  );
  assert.equal(invalid.calls.hashes.length, 0);
  assert.equal(invalid.calls.sends.length, 0);
});

test('corrupted counters and challenge material fail closed', async () => {
  const sendSetup = harness();
  sendSetup.db.seed('driver_otps', phone, {
    sendWindowStartedAt: FakeTimestamp.fromMillis(900_000),
    sendCount: '4',
  });
  await assert.rejects(sendSetup.service.sendDriverOtp(phone), /sendCount is invalid/);
  assert.equal(sendSetup.calls.sends.length, 0);

  const badTimestamp = harness();
  badTimestamp.db.seed('driver_otps', phone, { blockedUntil: 'not-a-timestamp' });
  await assert.rejects(badTimestamp.service.sendDriverOtp(phone), /blockedUntil is invalid/);
  assert.equal(badTimestamp.calls.hashes.length, 0);

  const verifySetup = harness();
  verifySetup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'malformed', salt: 'malformed',
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  await assert.rejects(verifySetup.service.verifyDriverOtp(phone, '123456'), /challenge data is invalid/);
  assert.equal(verifySetup.calls.verifies.length, 0);
  assert.equal(verifySetup.db.read('driver_otps', phone).attempts, 0);

  const badExpiry = harness();
  badExpiry.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: 'not-a-timestamp', attempts: 0, consumedAt: null,
  });
  await assert.rejects(badExpiry.service.verifyDriverOtp(phone, '123456'), /expiresAt is invalid/);
  assert.equal(badExpiry.calls.verifies.length, 0);
});

test('custom-token failure after verification leaves the challenge consumed and requires a new OTP', async () => {
  const setup = harness({
    auth: {
      getUserByPhoneNumber: async () => ({ uid: 'driver-1' }),
      createUser: async () => ({ uid: 'driver-1' }),
      createCustomToken: async () => { throw new Error('Auth token service unavailable'); },
    },
  });
  setup.db.seed('driver_otps', phone, {
    challengeId: 'challenge-1', hash: 'a'.repeat(128), salt: 'b'.repeat(32),
    expiresAt: FakeTimestamp.fromMillis(2_000_000), attempts: 0, consumedAt: null,
  });
  await assert.rejects(setup.service.verifyDriverOtp(phone, '123456'), /Auth token service unavailable/);
  const record = setup.db.read('driver_otps', phone);
  assert.equal(record.attempts, 1);
  assert.ok(record.consumedAt);
  assert.equal(record.verifiedUid, 'driver-1');
  await assert.rejects(setup.service.verifyDriverOtp(phone, '123456'), /already consumed/);
});
