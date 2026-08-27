'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCoordinates, haversineDistance } = require('../../../firebase/functions/src/utils/haversine');

test('coordinate validation accepts zero latitude and longitude', () => {
  assert.deepEqual(normalizeCoordinates({ lat: 0, lng: 0 }), { lat: 0, lng: 0 });
  assert.equal(haversineDistance({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
});

test('Haversine distance matches a hand-checkable equatorial degree', () => {
  const distance = haversineDistance({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(distance - 111.1949) < 0.001);
});

test('coordinate validation rejects non-finite and out-of-range values', () => {
  assert.throws(() => normalizeCoordinates({ lat: NaN, lng: 1 }), /finite/);
  assert.throws(() => normalizeCoordinates({ lat: 91, lng: 1 }), /outside/);
  assert.throws(() => normalizeCoordinates({ lat: 1, lng: -181 }), /outside/);
  assert.throws(() => normalizeCoordinates(null), /object/);
});
