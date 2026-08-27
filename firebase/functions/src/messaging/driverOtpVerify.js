'use strict';

const { verifyDriverOtp, OtpError } = require('../services/otpService');
const { normalizePhone } = require('../utils/phone');

function createDriverOtpVerifyHandler({ verifyOtp = verifyDriverOtp, normalize = normalizePhone } = {}) {
  return async function driverOtpVerify(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    try {
      const phone = normalize(req.body?.phone);
      const otp = req.body?.otp;
      if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
        return res.status(400).send({ success: false, message: 'OTP must be a 6-digit string' });
      }
      const token = await verifyOtp(phone, otp);
      return res.status(200).send({ success: true, token });
    } catch (error) {
      console.error('OTP verify error', {
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

const driverOtpVerify = createDriverOtpVerifyHandler();

module.exports = { createDriverOtpVerifyHandler, driverOtpVerify };
