'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateOtp, hashOtp, verifyOtp } = require('../../../firebase/functions/src/utils/otpCrypto');

test('OTP generation calls crypto.randomInt with the exact six-digit range', () => {
  const original = crypto.randomInt;
  let argumentsSeen;
  crypto.randomInt = (...args) => { argumentsSeen = args; return 654321; };
  try {
    assert.equal(generateOtp(), '654321');
    assert.deepEqual(argumentsSeen, [100000, 1000000]);
  } finally {
    crypto.randomInt = original;
  }
});

test('scrypt OTP hashes use random salts and a required pepper', async () => {
  const first = await hashOtp('123456', 'pepper-one');
  const second = await hashOtp('123456', 'pepper-one');
  assert.match(first.hash, /^[a-f0-9]{128}$/);
  assert.match(first.salt, /^[a-f0-9]{32}$/);
  assert.notEqual(first.salt, second.salt);
  assert.equal(await verifyOtp('123456', first.hash, first.salt, 'pepper-one'), true);
  assert.equal(await verifyOtp('123457', first.hash, first.salt, 'pepper-one'), false);
  assert.equal(await verifyOtp('123456', first.hash, first.salt, 'pepper-two'), false);
  await assert.rejects(hashOtp('123456', ''), /pepper/);
});

test('OTP crypto rejects malformed OTP and stored hash material', async () => {
  await assert.rejects(hashOtp('12345', 'pepper'), /6-digit/);
  await assert.rejects(verifyOtp('abcdef', '00', '00', 'pepper'), /6-digit/);
  assert.equal(await verifyOtp('123456', 'not-a-hash', 'not-a-salt', 'pepper'), false);
});
