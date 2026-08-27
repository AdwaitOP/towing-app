'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otpCrypto');
const { sendAuthenticationTemplate } = require('./whatsappClient');
const { requireEnv } = require('../utils/env');

class OtpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'OtpError';
    this.status = status;
    this.code = code;
  }
}

function createOtpService({
  db = getFirestore(),
  auth = getAuth(),
  TimestampClass = Timestamp,
  now = () => Date.now(),
  env = process.env,
  cryptoOps = { generateOtp, hashOtp, verifyOtp },
  whatsapp = { sendAuthenticationTemplate },
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  async function sendDriverOtp(phone) {
    const pepper = requireEnv('OTP_PEPPER', env);
    const otpRef = db.collection('driver_otps').doc(phone);
    const configRef = db.collection('business_config').doc('main');
    const [preflightConfig, preflightOtp] = await Promise.all([configRef.get(), otpRef.get()]);
    const preflightPolicy = readOtpPolicy(preflightConfig);
    readWhatsAppOtpTemplate(preflightConfig);
    const preflightNowMs = now();
    if (preflightOtp.exists) {
      const existing = preflightOtp.data();
      const blockedUntilMs = readTimestamp(existing.blockedUntil, 'blockedUntil');
      if (blockedUntilMs > preflightNowMs) {
        throw new OtpError('OTP sends are temporarily blocked', 429, 'OTP_SEND_BLOCKED');
      }
      const lastSentAtMs = readTimestamp(existing.lastSentAt, 'lastSentAt');
      if (
        lastSentAtMs &&
        preflightNowMs < lastSentAtMs + preflightPolicy.resendCooldownSeconds * 1000
      ) {
        throw new OtpError('Please wait before requesting another OTP', 429, 'OTP_RESEND_COOLDOWN');
      }
    }

    const otp = cryptoOps.generateOtp();
    const { hash, salt } = await cryptoOps.hashOtp(otp, pepper);
    const challengeId = randomUUID();

    const outcome = await db.runTransaction(async transaction => {
      const [configSnapshot, otpSnapshot] = await Promise.all([
        transaction.get(configRef),
        transaction.get(otpRef),
      ]);
      const policy = readOtpPolicy(configSnapshot);
      const template = readWhatsAppOtpTemplate(configSnapshot);
      const nowMs = now();
      const existing = otpSnapshot.exists ? otpSnapshot.data() : {};
      const existingBlockedUntil = readTimestamp(existing.blockedUntil, 'blockedUntil');
      if (existingBlockedUntil > nowMs) {
        return { rejected: 'blocked', retryAtMs: existingBlockedUntil };
      }

      let sendWindowStartedAtMs = readTimestamp(existing.sendWindowStartedAt, 'sendWindowStartedAt');
      let sendCount = readCounter(existing.sendCount, 'sendCount');
      const blockExpired = existingBlockedUntil > 0 && existingBlockedUntil <= nowMs;
      const windowExpired = !sendWindowStartedAtMs ||
        nowMs >= sendWindowStartedAtMs + policy.sendWindowSeconds * 1000;
      if (blockExpired || windowExpired) {
        sendWindowStartedAtMs = nowMs;
        sendCount = 0;
      }

      const lastSentAtMs = readTimestamp(existing.lastSentAt, 'lastSentAt');
      if (lastSentAtMs && nowMs < lastSentAtMs + policy.resendCooldownSeconds * 1000) {
        return {
          rejected: 'cooldown',
          retryAtMs: lastSentAtMs + policy.resendCooldownSeconds * 1000,
        };
      }

      if (sendCount >= policy.maxSendsPerWindow) {
        const blockedUntil = TimestampClass.fromMillis(nowMs + policy.blockDurationSeconds * 1000);
        transaction.set(otpRef, { blockedUntil }, { merge: true });
        return { rejected: 'blocked', retryAtMs: blockedUntil.toMillis() };
      }

      const sentAt = TimestampClass.fromMillis(nowMs);
      transaction.set(otpRef, {
        challengeId,
        hash,
        salt,
        expiresAt: TimestampClass.fromMillis(nowMs + policy.otpExpirySeconds * 1000),
        attempts: 0,
        consumedAt: null,
        verifiedUid: null,
        lastSentAt: sentAt,
        sendWindowStartedAt: TimestampClass.fromMillis(sendWindowStartedAtMs),
        sendCount: sendCount + 1,
        blockedUntil: null,
      }, { merge: true });
      return { rejected: null, template };
    });

    if (outcome.rejected === 'blocked') {
      throw new OtpError('OTP sends are temporarily blocked', 429, 'OTP_SEND_BLOCKED');
    }
    if (outcome.rejected === 'cooldown') {
      throw new OtpError('Please wait before requesting another OTP', 429, 'OTP_RESEND_COOLDOWN');
    }

    try {
      await whatsapp.sendAuthenticationTemplate(phone, otp, outcome.template);
    } catch (error) {
      const wrapped = new OtpError('Failed to send OTP via WhatsApp', 503, 'OTP_DELIVERY_FAILED');
      wrapped.cause = error;
      throw wrapped;
    }
    return { challengeId };
  }

  async function verifyDriverOtp(phone, otp) {
    const pepper = requireEnv('OTP_PEPPER', env);
    const otpRef = db.collection('driver_otps').doc(phone);
    const configRef = db.collection('business_config').doc('main');

    const challenge = await db.runTransaction(async transaction => {
      const [configSnapshot, otpSnapshot] = await Promise.all([
        transaction.get(configRef),
        transaction.get(otpRef),
      ]);
      const policy = readOtpPolicy(configSnapshot);
      if (!otpSnapshot.exists) throw new OtpError('No OTP requested', 401, 'OTP_NOT_FOUND');
      const data = otpSnapshot.data();
      if (data.consumedAt) throw new OtpError('OTP already consumed', 401, 'OTP_CONSUMED');
      if (readTimestamp(data.expiresAt, 'expiresAt', true) <= now()) {
        throw new OtpError('OTP expired', 401, 'OTP_EXPIRED');
      }
      const attempts = readCounter(data.attempts, 'attempts');
      if (attempts >= policy.maxVerificationAttempts) {
        throw new OtpError('Maximum OTP attempts exceeded', 401, 'OTP_ATTEMPTS_EXCEEDED');
      }
      if (
        typeof data.challengeId !== 'string' || !data.challengeId ||
        typeof data.hash !== 'string' || !/^[a-f0-9]{128}$/i.test(data.hash) ||
        typeof data.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(data.salt)
      ) {
        throw new OtpError('OTP challenge data is invalid', 503, 'OTP_CHALLENGE_INVALID');
      }
      transaction.update(otpRef, { attempts: attempts + 1 });
      return {
        challengeId: data.challengeId,
        hash: data.hash,
        salt: data.salt,
        expiresAtMs: readTimestamp(data.expiresAt, 'expiresAt', true),
      };
    });

    const valid = await cryptoOps.verifyOtp(otp, challenge.hash, challenge.salt, pepper);
    if (!valid) throw new OtpError('Invalid OTP', 401, 'OTP_INVALID');

    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(otpRef);
      if (!snapshot.exists) throw new OtpError('OTP challenge disappeared', 409, 'OTP_REPLACED');
      const data = snapshot.data();
      if (
        data.challengeId !== challenge.challengeId ||
        data.hash !== challenge.hash ||
        data.salt !== challenge.salt
      ) {
        throw new OtpError('OTP challenge was replaced', 409, 'OTP_REPLACED');
      }
      if (data.consumedAt) throw new OtpError('OTP already consumed', 401, 'OTP_CONSUMED');
      if (readTimestamp(data.expiresAt, 'expiresAt', true) <= now()) {
        throw new OtpError('OTP expired', 401, 'OTP_EXPIRED');
      }
      transaction.update(otpRef, {
        consumedAt: TimestampClass.fromMillis(now()),
      });
    });

    const uid = await findOrCreateAuthUser(phone);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(otpRef);
      if (!snapshot.exists) throw new OtpError('OTP challenge disappeared', 409, 'OTP_REPLACED');
      const data = snapshot.data();
      if (data.challengeId !== challenge.challengeId || !data.consumedAt) {
        throw new OtpError('OTP challenge was replaced', 409, 'OTP_REPLACED');
      }
      transaction.update(otpRef, { verifiedUid: uid });
    });
    const customToken = await auth.createCustomToken(uid);
    return customToken;
  }

  async function findOrCreateAuthUser(phone) {
    try {
      return (await auth.getUserByPhoneNumber(phone)).uid;
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    try {
      return (await auth.createUser({ phoneNumber: phone })).uid;
    } catch (error) {
      if (!['auth/phone-number-already-exists', 'auth/uid-already-exists'].includes(error?.code)) throw error;
      return (await auth.getUserByPhoneNumber(phone)).uid;
    }
  }

  return { sendDriverOtp, verifyDriverOtp };
}

function readOtpPolicy(snapshot) {
  if (!snapshot.exists) throw new OtpError('OTP policy is not configured', 503, 'OTP_POLICY_MISSING');
  const policy = snapshot.data()?.otpPolicy;
  const fields = [
    'otpExpirySeconds',
    'resendCooldownSeconds',
    'maxSendsPerWindow',
    'sendWindowSeconds',
    'blockDurationSeconds',
    'maxVerificationAttempts',
  ];
  if (!policy || typeof policy !== 'object') {
    throw new OtpError('OTP policy is not configured', 503, 'OTP_POLICY_MISSING');
  }
  for (const field of fields) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] <= 0) {
      throw new OtpError(`OTP policy field ${field} is invalid`, 503, 'OTP_POLICY_INVALID');
    }
  }
  return policy;
}

function readWhatsAppOtpTemplate(snapshot) {
  if (!snapshot.exists) {
    throw new OtpError('WhatsApp OTP template is not configured', 503, 'OTP_TEMPLATE_MISSING');
  }
  const template = snapshot.data()?.whatsappOtpTemplate;
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new OtpError('WhatsApp OTP template is not configured', 503, 'OTP_TEMPLATE_MISSING');
  }
  const templateName = template.templateName;
  const languageCode = template.languageCode;
  if (
    typeof templateName !== 'string' ||
    templateName !== templateName.trim() ||
    templateName.length > 512 ||
    !/^[a-z0-9_]+$/.test(templateName) ||
    typeof languageCode !== 'string' ||
    languageCode !== languageCode.trim() ||
    !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)
  ) {
    throw new OtpError('WhatsApp OTP template configuration is invalid', 503, 'OTP_TEMPLATE_INVALID');
  }
  return { templateName, languageCode };
}

function readCounter(value, field) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OtpError(`OTP ${field} is invalid`, 503, 'OTP_CHALLENGE_INVALID');
  }
  return value;
}

function readTimestamp(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new OtpError(`OTP ${field} is invalid`, 503, 'OTP_CHALLENGE_INVALID');
    return 0;
  }
  let milliseconds;
  if (typeof value.toMillis === 'function') milliseconds = value.toMillis();
  else if (value instanceof Date) milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new OtpError(`OTP ${field} is invalid`, 503, 'OTP_CHALLENGE_INVALID');
  }
  return milliseconds;
}

let defaultService;
function getDefaultService() {
  if (!defaultService) defaultService = createOtpService();
  return defaultService;
}

module.exports = {
  OtpError,
  createOtpService,
  readOtpPolicy,
  readWhatsAppOtpTemplate,
  sendDriverOtp: (...args) => getDefaultService().sendDriverOtp(...args),
  verifyDriverOtp: (...args) => getDefaultService().verifyDriverOtp(...args),
};
