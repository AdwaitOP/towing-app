'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { safeCompare, verifySignature } = require('../../../firebase/functions/src/utils/hmac');

test('HMAC verification uses the exact raw bytes and required prefix', () => {
  const raw = Buffer.from('{"amount":100,"order":"exact"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(raw).digest('hex')}`;
  assert.equal(verifySignature(raw, signature, 'secret', 'sha256='), true);
  assert.equal(verifySignature(Buffer.from(raw.toString().replace('100', '101')), signature, 'secret', 'sha256='), false);
  assert.equal(verifySignature(raw, signature.slice(7), 'secret', 'sha256='), false);
});

test('timing-safe comparison fails closed for types and unequal lengths', () => {
  assert.equal(safeCompare('same', 'same'), true);
  assert.equal(safeCompare('same', 'different'), false);
  assert.equal(safeCompare(null, 'same'), false);
});
