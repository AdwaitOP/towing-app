'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createOlaMapsClient } = require('../../../firebase/functions/src/services/olaMapsClient');
const { matrixBody } = require('../fixtures');
const coords = { origins: [{ lat: 18.52, lng: 73.85 }], destinations: [{ lat: 18.55, lng: 73.88 }] };
const authorizeAttempt = async () => ({ authorized: true });
const args = { ...coords, authorizeAttempt };
function clientWith(body, extra = {}) {
  return createOlaMapsClient({ apiKey: 'test', backoffMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }), ...extra });
}
test('missing key rejects without HTTP', async () => {
  await assert.rejects(() => clientWith(matrixBody(), { apiKey: '' }).getDistanceMatrix(args), { code: 'OLA_API_KEY_MISSING' });
});
test('authorization callback is required: no unaccounted HTTP', async () => {
  await assert.rejects(() => clientWith(matrixBody()).getDistanceMatrix(coords), { code: 'OLA_AUTHORIZATION_MISSING' });
});
test('coordinates reject strings and out-of-range numbers', async () => {
  for (const lat of ['18', NaN, Infinity, 91]) await assert.rejects(() => clientWith(matrixBody()).getDistanceMatrix({
    ...args, origins: [{ lat, lng: 73 }],
  }), RangeError);
});
test('strict successful matrix preserves numeric metrics and origin/destination order', async () => {
  const body = matrixBody(2, 2);
  body.rows[0].elements[0].duration = { value: 12.5 };
  body.rows[1].elements[1].distance = { value: 345 };
  const result = await clientWith(body).getDistanceMatrix({ ...args, origins: [...coords.origins, ...coords.origins],
    destinations: [...coords.destinations, ...coords.destinations] });
  assert.equal(result[0][0].durationSeconds, 12.5);
  assert.equal(result[1][1].distanceMeters, 345);
});
const malformed = [
  ['missing rows', {}], ['short rows', matrixBody(0)], ['extra rows', matrixBody(2)],
  ['short elements', matrixBody(1, 0)], ['extra elements', matrixBody(1, 2)],
  ['matrix alias', { matrix: matrixBody().rows }], ['null row', { rows: [null] }],
  ['failed outer status', { ...matrixBody(), status: 'ERROR' }],
  ['unexpected body', '<html>error</html>'],
];
for (const status of ['ZERO_RESULTS', 'NOT_FOUND', undefined]) {
  const body = matrixBody(); body.rows[0].elements[0].status = status; malformed.push(['status ' + status, body]);
}
for (const field of ['duration', 'distance']) for (const value of [null, NaN, Infinity, -1, '300', {}, undefined]) {
  const body = matrixBody(); body.rows[0].elements[0][field] = value; malformed.push([field + ' ' + String(value), body]);
}
for (const [label, body] of malformed) test('response rejects ' + label, async () => {
  await assert.rejects(() => clientWith(body).getDistanceMatrix(args), error => {
    assert.equal(error.code, 'OLA_MALFORMED_RESPONSE'); assert.equal(error.degradedAllowed, false); return true;
  });
});
test('malformed JSON does not retry or degrade', async () => {
  let calls = 0;
  const client = clientWith(null, { fetchImpl: async () => {
    calls++; return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad body'); } };
  } });
  await assert.rejects(() => client.getDistanceMatrix(args), { code: 'OLA_MALFORMED_RESPONSE' });
  assert.equal(calls, 1);
});
test('unexpected successful HTTP status is rejected', async () => {
  await assert.rejects(() => clientWith(null, { fetchImpl: async () => ({ ok: true, status: 204 }) }).getDistanceMatrix(args),
    { code: 'OLA_MALFORMED_RESPONSE' });
});
for (const status of [400, 401, 403]) test('HTTP ' + status + ' has no retry/degradation', async () => {
  let calls = 0;
  const client = clientWith(null, { fetchImpl: async () => { calls++; return { ok: false, status }; } });
  await assert.rejects(() => client.getDistanceMatrix(args), error => error.retryable === false && error.degradedAllowed === false);
  assert.equal(calls, 1);
});
test('429 then 500 then success reserves each HTTP attempt', async () => {
  let calls = 0;
  const reservations = [];
  const client = clientWith(null, { fetchImpl: async () => {
    calls++; return calls < 3 ? { ok: false, status: calls === 1 ? 429 : 500 } :
      { ok: true, status: 200, json: async () => matrixBody() };
  } });
  await client.getDistanceMatrix({ ...coords, authorizeAttempt: async reservation => {
    reservations.push(reservation.plannedPairs); return { authorized: true };
  } });
  assert.equal(calls, 3); assert.deepEqual(reservations, [1, 1, 1]);
});
test('cap denial before retry stops provider calls and explicitly permits degradation', async () => {
  let calls = 0, reservations = 0;
  const client = clientWith(null, { fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(() => client.getDistanceMatrix({ ...coords, authorizeAttempt: async () => {
    reservations++; return reservations === 1 ? { authorized: true } : { authorized: false, reason: 'CAP_EXCEEDED' };
  } }), error => error.code === 'CAP_EXCEEDED' && error.degradedAllowed);
  assert.equal(calls, 1); assert.equal(reservations, 2);
});
test('counter or authorization failure escapes without HTTP retry/degradation', async () => {
  let calls = 0;
  const sentinel = new Error('counter invalid');
  await assert.rejects(() => clientWith(null, { fetchImpl: async () => { calls++; } }).getDistanceMatrix({
    ...coords, authorizeAttempt: async () => { throw sentinel; },
  }), error => error === sentinel);
  assert.equal(calls, 0);
});
for (const [name, error] of [
  ['timeout', Object.assign(new Error(), { name: 'AbortError' })],
  ['network transient', Object.assign(new Error(), { cause: { code: 'ECONNRESET' } })],
]) test(name + ' retries only within bound then permits degradation', async () => {
  let calls = 0;
  const client = clientWith(null, { fetchImpl: async () => { calls++; throw error; } });
  await assert.rejects(() => client.getDistanceMatrix(args), e => e.retryable && e.degradedAllowed);
  assert.equal(calls, 3);
});
test('arbitrary local errors cannot masquerade as network transients', async () => {
  let calls = 0;
  await assert.rejects(() => clientWith(null, { fetchImpl: async () => { calls++; throw new TypeError('bug'); } })
    .getDistanceMatrix(args), { code: 'OLA_LOCAL_ERROR', degradedAllowed: false });
  assert.equal(calls, 1);
});
