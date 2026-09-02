'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createUsageCounterService } = require('../../../firebase/functions/src/services/usageCounterService');
const { FakeFirestore, FakeTimestamp: T } = require('../fakeDeps');
const { config } = require('../fixtures');
const nowMs = Date.parse('2026-09-02T10:00:00Z');
function setup(cap = 100) {
  const db = new FakeFirestore();
  db.seed('dispatch_config', 'main', config(T, nowMs, { olaMonthlyPairCap: cap }));
  return { db, service: createUsageCounterService({ db, TimestampClass: T, now: () => new Date(nowMs) }) };
}
test('absent counter bootstrap uses the approved exact defaults', async () => {
  const { db, service } = setup();
  const result = await service.reserveOlaMatrixUsage({ plannedPairs: 5 });
  assert.equal(result.authorized, true);
  assert.deepEqual(db.read('usage_counters', '2026-09'), {
    olaMapsMatrixRequests: 1, olaMapsMatrixPairs: 5, whatsappTemplateSends: 0, softCapWhatsapp: 900,
    updatedAt: T.fromMillis(nowMs),
  });
});
test('null current cap disables requests without creating a counter', async () => {
  const { db, service } = setup(null);
  assert.deepEqual(await service.reserveOlaMatrixUsage({ plannedPairs: 5, cap: 100 }), {
    authorized: false, reason: 'OLA_DISABLED', monthKey: '2026-09',
  });
  assert.equal(db.read('usage_counters', '2026-09'), undefined);
});
test('malformed config fails closed', async () => {
  const { service } = setup(-1);
  await assert.rejects(() => service.reserveOlaMatrixUsage({ plannedPairs: 1 }), { code: 'CONFIG_INVALID' });
});
for (const plannedPairs of [0, -1, NaN, Infinity, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid planned pairs ' + String(plannedPairs), async () => {
    await assert.rejects(() => setup().service.reserveOlaMatrixUsage({ plannedPairs }), { code: 'USAGE_PAIRS_INVALID' });
  });
}
