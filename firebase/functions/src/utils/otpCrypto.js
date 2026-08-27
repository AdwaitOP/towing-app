'use strict';

const crypto = require('crypto');
const util = require('util');

const scrypt = util.promisify(crypto.scrypt);
const KEY_LENGTH = 64;

function assertOtp(otp) {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
    throw new TypeError('OTP must be a 6-digit string');
  }
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function hashOtp(otp, pepper) {
  assertOtp(otp);
  if (!pepper) throw new Error('Server pepper is required for OTP hashing');
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scrypt(otp + pepper, salt, KEY_LENGTH);
  return { hash: derivedKey.toString('hex'), salt };
}

async function verifyOtp(otp, storedHash, storedSalt, pepper) {
  assertOtp(otp);
  if (!pepper) throw new Error('Server pepper is required for OTP verification');
  if (typeof storedHash !== 'string' || !/^[a-f0-9]{128}$/i.test(storedHash)) return false;
  if (typeof storedSalt !== 'string' || !/^[a-f0-9]{32}$/i.test(storedSalt)) return false;
  const derivedKey = await scrypt(otp + pepper, storedSalt, KEY_LENGTH);
  const storedBuffer = Buffer.from(storedHash, 'hex');
  if (derivedKey.length !== storedBuffer.length) return false;
  return crypto.timingSafeEqual(Buffer.from(derivedKey), storedBuffer);
}

module.exports = { generateOtp, hashOtp, verifyOtp };
