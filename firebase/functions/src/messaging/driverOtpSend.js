'use strict';

const { sendDriverOtp, OtpError } = require('../services/otpService');
const { normalizePhone } = require('../utils/phone');

function createDriverOtpSendHandler({ sendOtp = sendDriverOtp, normalize = normalizePhone } = {}) {
  return async function driverOtpSend(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    try {
      const phone = normalize(req.body?.phone);
      await sendOtp(phone);
      return res.status(200).send({ success: true, message: 'OTP sent' });
    } catch (error) {
      console.error('OTP send error', {
        name: error?.name,
        code: error?.code,
        status: error?.status,
      });
      if (error instanceof OtpError) {
        return res.status(error.status).send({ success: false, code: error.code, message: error.message });
      }
      if (error instanceof TypeError) {
        return res.status(400).send({ success: false, message: error.message });
      }
      return res.status(500).send({ success: false, message: 'Internal Server Error' });
    }
  };
}

const driverOtpSend = createDriverOtpSendHandler();

module.exports = { createDriverOtpSendHandler, driverOtpSend };
