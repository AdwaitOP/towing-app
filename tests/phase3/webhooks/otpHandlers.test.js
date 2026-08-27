'use strict';

const { createMockResponse } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { OtpError } = require('../../../firebase/functions/src/services/otpService');
const {
  createDriverOtpSendHandler,
} = require('../../../firebase/functions/src/messaging/driverOtpSend');
const {
  createDriverOtpVerifyHandler,
} = require('../../../firebase/functions/src/messaging/driverOtpVerify');

test('OTP send HTTP handler normalizes the phone and returns success only after service completion', async () => {
  const calls = [];
  const handler = createDriverOtpSendHandler({
    normalize: value => { calls.push(['normalize', value]); return '+919876543210'; },
    sendOtp: async phone => { calls.push(['send', phone]); },
  });
  const res = createMockResponse();
  await handler({ method: 'POST', body: { phone: '9876543210' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, message: 'OTP sent' });
  assert.deepEqual(calls, [
    ['normalize', '9876543210'],
    ['send', '+919876543210'],
  ]);
});

test('OTP send HTTP handler preserves policy errors and rejects non-POST requests', async () => {
  const handler = createDriverOtpSendHandler({
    normalize: () => '+919876543210',
    sendOtp: async () => { throw new OtpError('blocked', 429, 'OTP_SEND_BLOCKED'); },
  });
  const blocked = createMockResponse();
  await handler({ method: 'POST', body: { phone: '9876543210' } }, blocked);
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.body, { success: false, code: 'OTP_SEND_BLOCKED', message: 'blocked' });

  const wrongMethod = createMockResponse();
  await handler({ method: 'GET' }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('OTP verify HTTP handler validates shape and passes normalized identity to the service', async () => {
  const calls = [];
  const handler = createDriverOtpVerifyHandler({
    normalize: value => { calls.push(['normalize', value]); return '+919876543210'; },
    verifyOtp: async (phone, otp) => { calls.push(['verify', phone, otp]); return 'custom-token'; },
  });
  const success = createMockResponse();
  await handler({ method: 'POST', body: { phone: '9876543210', otp: '123456' } }, success);
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.body, { success: true, token: 'custom-token' });
  assert.deepEqual(calls, [
    ['normalize', '9876543210'],
    ['verify', '+919876543210', '123456'],
  ]);

  const malformed = createMockResponse();
  await handler({ method: 'POST', body: { phone: '9876543210', otp: 123456 } }, malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.filter(call => call[0] === 'verify').length, 1);
});

test('OTP verify HTTP handler surfaces verification policy failures without minting success', async () => {
  const handler = createDriverOtpVerifyHandler({
    normalize: () => '+919876543210',
    verifyOtp: async () => { throw new OtpError('expired', 401, 'OTP_EXPIRED'); },
  });
  const res = createMockResponse();
  await handler({ method: 'POST', body: { phone: '9876543210', otp: '123456' } }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { success: false, code: 'OTP_EXPIRED', message: 'expired' });
});
