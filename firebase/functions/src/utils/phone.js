'use strict';

function normalizePhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') {
    throw new TypeError('Phone number is required');
  }
  let input = String(phone).trim();
  if (!input) throw new TypeError('Phone number is required');
  if (!/^\+?[0-9\s().-]+$/.test(input)) {
    throw new TypeError('Phone number contains invalid characters');
  }
  input = input.replace(/[\s().-]/g, '');
  if (input.startsWith('00')) input = `+${input.slice(2)}`;

  let digits = input.startsWith('+') ? input.slice(1) : input;
  if (!/^\d+$/.test(digits)) throw new TypeError('Invalid phone number');
  if (!input.startsWith('+')) {
    if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
    else if (/^0[6-9]\d{9}$/.test(digits)) digits = `91${digits.slice(1)}`;
    else if (!/^91[6-9]\d{9}$/.test(digits)) {
      throw new TypeError('Phone number must be E.164 or a valid Indian mobile number');
    }
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new TypeError('Phone number is not valid E.164');
  }
  return `+${digits}`;
}

module.exports = { normalizePhone };
