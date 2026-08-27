'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getServiceType } = require('../../../firebase/functions/src/utils/truckTypeMapper');

test('customer towing categories map only at the Phase 2 boundary', () => {
  assert.equal(getServiceType('flatbed'), 'flatbed');
  assert.equal(getServiceType('pulling'), 'standard');
  assert.throws(() => getServiceType('standard'), /Invalid requestedTruckType/);
});
