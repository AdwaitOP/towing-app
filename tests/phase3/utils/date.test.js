'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { getIstHour, getIstDateString } = require('../../../firebase/functions/src/utils/date');

test('IST conversion handles the exact UTC date boundary', () => {
  assert.equal(getIstHour(new Date('2026-01-01T18:29:59.000Z')), 23);
  assert.equal(getIstDateString(new Date('2026-01-01T18:29:59.000Z')), '2026-01-01');
  assert.equal(getIstHour(new Date('2026-01-01T18:30:00.000Z')), 0);
  assert.equal(getIstDateString(new Date('2026-01-01T18:30:00.000Z')), '2026-01-02');
});

test('IST results are independent of the server TZ environment', () => {
  const modulePath = path.resolve(__dirname, '../../../firebase/functions/src/utils/date.js');
  const script = `const d=require(${JSON.stringify(modulePath)});process.stdout.write(d.getIstHour(new Date('2026-08-25T20:00:00Z'))+'|'+d.getIstDateString(new Date('2026-08-25T20:00:00Z')))`;
  const run = tz => execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz },
  });
  assert.equal(run('UTC'), '1|2026-08-26');
  assert.equal(run('America/Los_Angeles'), '1|2026-08-26');
});

test('date utilities reject invalid Date objects', () => {
  assert.throws(() => getIstHour(new Date('invalid')), /valid Date/);
  assert.throws(() => getIstDateString('2026-01-01'), /valid Date/);
});
