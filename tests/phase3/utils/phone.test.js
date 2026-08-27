'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../../../firebase/functions/src/utils/phone');

test('phone normalization canonicalizes supported Indian and E.164 forms', () => {
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 (98765) 43210'), '+919876543210');
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
});

test('phone normalization rejects lossy or malformed inputs', () => {
  for (const value of ['', 'call 9876543210', '12345', '1234567890', '+0123456789', null]) {
    assert.throws(() => normalizePhone(value));
  }
});
