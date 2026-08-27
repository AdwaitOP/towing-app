const crypto = require('crypto');

/**
 * Timing-safe string comparison.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verifies a webhook signature using HMAC SHA256.
 */
function verifySignature(payloadBuffer, signature, secret, prefix = '') {
  if (!signature || !secret || !payloadBuffer) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadBuffer);
  const expectedSignature = prefix + hmac.digest('hex');
  return safeCompare(signature, expectedSignature);
}

module.exports = { safeCompare, verifySignature };
