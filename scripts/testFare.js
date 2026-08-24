#!/usr/bin/env node
'use strict';

/**
 * testFare.js — Phase 2 offline test script for fareCalculator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero-dependency: uses only Node.js built-in modules.
 * Does NOT require Firebase, the Firebase emulator, or npm install.
 *
 * Run from the repo root:
 *   node scripts/testFare.js
 *
 * Exits with code 0 if all tests pass, non-zero if any test fails.
 *
 * Expected values are hand-calculated against the Phase 1 seed config
 * (firebase/seed/pricing_config.json, metadata keys stripped).
 * The production calculation logic lives exclusively in fareCalculator.js.
 * This script tests the exported pure functions — it does not re-implement them.
 *
 * All monetary expected values are in integer paise (INR × 100).
 */

const assert = require('node:assert/strict');
const path = require('node:path');

// Import only the pure functions — no Firebase Admin is loaded.
// getPricingConfig() is NOT called in this script.
const { calculateCommission, calculateFare, validateConfig } = require(
  path.join(__dirname, '..', 'firebase', 'functions', 'src', 'fareCalculator')
);

// ── Inline config ─────────────────────────────────────────────────────────────
// Matches firebase/seed/pricing_config.json exactly, with all _comment/_note/
// _tier3_formula_note metadata keys omitted (as getPricingConfig() would strip them).
const C = {
  booking_tiers: {
    short_distance_limit_km: 10,
    long_distance_limit_km: 15,
    tier1_booking_fee: 100,
    tier1_driver_commission: 200,
    tier2_booking_fee: 200,
    tier2_driver_commission: 300,
    tier3_booking_fee: 300,
    tier3_driver_commission_base: 300,
    per_km_overage_rate: 50,
  },
  fare_formula: {
    base_fare_standard: 1500,
    base_fare_flatbed: 2000,
    per_km_rate: 75,
    road_curvature_factor: 1.3,
    night_surge_multiplier: 1.25,
    night_surge_start_hour: 22,
    night_surge_end_hour: 6,
    highway_surge_multiplier: 1.2,
    highway_distance_threshold_km: 20,
    round_to_nearest: 10,
  },
};

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function run(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${label}`);
    // Print assertion details (expected vs actual) or the thrown message
    const detail = err.message || String(err);
    console.log(`        ${detail}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — calculateCommission: tier boundaries and commission formula
// ─────────────────────────────────────────────────────────────────────────────
//
// Hand-calculated expected values (monetary units: paise = INR × 100):
//
//   Tier 1 (dist <= 10 km):  bookingFee=100 INR=10000p, commission=200 INR=20000p
//   Tier 2 (10 < dist <=15): bookingFee=200 INR=20000p, commission=300 INR=30000p
//   Tier 3 (dist > 15 km):   bookingFee=300 INR=30000p,
//                             commission=(300 + 50×overage) INR × 100
//     dist=15.1: overage=0.1 → 300+5=305 INR=30500p
//     dist=20.0: overage=5   → 300+250=550 INR=55000p
//     dist=25.0: overage=10  → 300+500=800 INR=80000p
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── calculateCommission: tier selection ──────────────────────────────────');

run('Tier 1 — zero distance (0 km)', () => {
  assert.deepStrictEqual(
    calculateCommission(0, C),
    { tier: 1, bookingFeePaise: 10000, driverCommissionPaise: 20000 }
  );
});

run('Tier 1 — mid-range (5 km)', () => {
  assert.deepStrictEqual(
    calculateCommission(5, C),
    { tier: 1, bookingFeePaise: 10000, driverCommissionPaise: 20000 }
  );
});

run('Tier 1 — at boundary (exactly 10.0 km)', () => {
  assert.deepStrictEqual(
    calculateCommission(10.0, C),
    { tier: 1, bookingFeePaise: 10000, driverCommissionPaise: 20000 }
  );
});

run('Tier 2 — just over lower boundary (10.1 km)', () => {
  assert.deepStrictEqual(
    calculateCommission(10.1, C),
    { tier: 2, bookingFeePaise: 20000, driverCommissionPaise: 30000 }
  );
});

run('Tier 2 — at upper boundary (exactly 15.0 km)', () => {
  assert.deepStrictEqual(
    calculateCommission(15.0, C),
    { tier: 2, bookingFeePaise: 20000, driverCommissionPaise: 30000 }
  );
});

run('Tier 3 — decimal overage (15.01 km): commission = (300+50×0.01)×100 = 30050p', () => {
  const res = calculateCommission(15.01, C);
  assert.strictEqual(res.tier, 3);
  assert.strictEqual(res.bookingFeePaise, 30000);
  assert.strictEqual(Number.isInteger(res.driverCommissionPaise), true);
  assert.strictEqual(res.driverCommissionPaise, 30050);
});

run('Tier 3 — just over boundary (15.1 km): commission = (300+50×0.1)×100 = 30500p', () => {
  assert.deepStrictEqual(
    calculateCommission(15.1, C),
    { tier: 3, bookingFeePaise: 30000, driverCommissionPaise: 30500 }
  );
});

run('Tier 3 — 20 km: commission = (300+50×5)×100 = 55000p', () => {
  assert.deepStrictEqual(
    calculateCommission(20.0, C),
    { tier: 3, bookingFeePaise: 30000, driverCommissionPaise: 55000 }
  );
});

run('Tier 3 — decimal overage (20.123 km): commission = (300+50×5.123)×100 = 55615p', () => {
  const res = calculateCommission(20.123, C);
  assert.strictEqual(res.tier, 3);
  assert.strictEqual(res.bookingFeePaise, 30000);
  assert.strictEqual(Number.isInteger(res.driverCommissionPaise), true);
  assert.strictEqual(res.driverCommissionPaise, 55615);
});

run('Tier 3 — 25 km: commission = (300+50×10)×100 = 80000p', () => {
  assert.deepStrictEqual(
    calculateCommission(25.0, C),
    { tier: 3, bookingFeePaise: 30000, driverCommissionPaise: 80000 }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — calculateFare: service types, hour boundaries, highway boundary,
//             surge stacking, rounding
// ─────────────────────────────────────────────────────────────────────────────
//
// Formula (Phase 2 pricing rule):
//   fare = (base + dist×75) × 1.3 × [night?×1.25] × [highway?×1.2]
//   round to nearest ₹10, then × 100 for paise
//
// Night window: hour >= 22 OR hour < 6
//   NIGHT:   hr 22, 23, 0–5
//   DAYTIME: hr 6–21 (hr 6 is NOT night)
//
// Highway: dist strictly > 20 km (exactly 20.0 → no surge; 20.1 → surge)
//
// Hand-calculated expected values:
//   dist=5, std, day:   (1500+375)×1.3=2437.5 → round→2440 INR = 244000p
//   dist=5, flat, day:  (2000+375)×1.3=3087.5 → round→3090 INR = 309000p
//   dist=5, std, night: 2437.5×1.25=3046.875  → round→3050 INR = 305000p
//   dist=20.0, std, day:(1500+1500)×1.3=3900, no highway   = 390000p
//   dist=20.1, std, day:(1500+1507.5)×1.3×1.2=3007.5×1.56=4691.7 → round→4690 INR = 469000p
//   dist=25.0, std, day:3375×1.3×1.2=5265 → round→5270 INR = 527000p
//   dist=25.0, std, night+highway: 3375×1.3×1.25×1.2=6581.25 → round→6580 INR = 658000p
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── calculateFare: service types ─────────────────────────────────────────');

run('standard, 0 km, day (hr 10): (1500+0)×1.3 → 1950 INR = 195000p', () => {
  assert.deepStrictEqual(
    calculateFare(0, 'standard', 10, C),
    { estimatedFarePaise: 195000, isNight: false, isHighway: false }
  );
});

run('standard, 5 km, day (hr 10): (1500+375)×1.3 → 2440 INR = 244000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 10, C),
    { estimatedFarePaise: 244000, isNight: false, isHighway: false }
  );
});

run('flatbed, 5 km, day (hr 10): (2000+375)×1.3 → 3090 INR = 309000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'flatbed', 10, C),
    { estimatedFarePaise: 309000, isNight: false, isHighway: false }
  );
});

console.log('\n── calculateFare: night-surge hour boundaries ───────────────────────────');

run('hr 0 (midnight) — NIGHT (< 6, exclusive): night surge → 305000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 0, C),
    { estimatedFarePaise: 305000, isNight: true, isHighway: false }
  );
});

run('hr 21 — NOT night (21 < 22 and 21 >= 6): no night surge → 244000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 21, C),
    { estimatedFarePaise: 244000, isNight: false, isHighway: false }
  );
});

run('hr 22 — NIGHT start (>= 22, inclusive): night surge → 305000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 22, C),
    { estimatedFarePaise: 305000, isNight: true, isHighway: false }
  );
});

run('hr 23 — NIGHT: night surge → 305000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 23, C),
    { estimatedFarePaise: 305000, isNight: true, isHighway: false }
  );
});

run('hr 5 — NIGHT (< 6, exclusive): night surge → 305000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 5, C),
    { estimatedFarePaise: 305000, isNight: true, isHighway: false }
  );
});

run('hr 6 — NOT night (6 is not < 6): no night surge → 244000p', () => {
  assert.deepStrictEqual(
    calculateFare(5, 'standard', 6, C),
    { estimatedFarePaise: 244000, isNight: false, isHighway: false }
  );
});

console.log('\n── calculateFare: highway-surge distance boundaries ─────────────────────');

run('20.0 km — NOT highway (20.0 is not > 20): no highway surge → 390000p', () => {
  // (1500+1500)×1.3 = 3900 INR = 390000p
  assert.deepStrictEqual(
    calculateFare(20.0, 'standard', 10, C),
    { estimatedFarePaise: 390000, isNight: false, isHighway: false }
  );
});

run('20.1 km — HIGHWAY (> 20): (1500+1507.5)×1.3×1.2 → 4690 INR = 469000p', () => {
  // 3007.5 × 1.3 = 3909.75, × 1.2 = 4691.7 → round to nearest 10 → 4690
  assert.deepStrictEqual(
    calculateFare(20.1, 'standard', 10, C),
    { estimatedFarePaise: 469000, isNight: false, isHighway: true }
  );
});

run('25.0 km — HIGHWAY: (1500+1875)×1.3×1.2 → 5270 INR = 527000p', () => {
  // 3375 × 1.3 = 4387.5, × 1.2 = 5265 → round → 5270
  assert.deepStrictEqual(
    calculateFare(25.0, 'standard', 10, C),
    { estimatedFarePaise: 527000, isNight: false, isHighway: true }
  );
});

console.log('\n── calculateFare: surge stacking (multiplicative, Phase 2 pricing rule) ─');

run('25 km, hr 23 — NIGHT + HIGHWAY stack: 3375×1.3×1.25×1.2 → 6580 INR = 658000p', () => {
  // 3375 × 1.3 = 4387.5, × 1.25 = 5484.375, × 1.2 = 6581.25 → round → 6580
  assert.deepStrictEqual(
    calculateFare(25.0, 'standard', 23, C),
    { estimatedFarePaise: 658000, isNight: true, isHighway: true }
  );
});

console.log('\n── calculateFare: rounding ──────────────────────────────────────────────');

run('Result is rounded to nearest ₹10 (2437.5 → 2440, not truncated to 2430)', () => {
  // 5km standard day produces 2437.5 pre-rounding — verifies round-up behaviour
  const { estimatedFarePaise } = calculateFare(5, 'standard', 10, C);
  assert.strictEqual(estimatedFarePaise % 1000, 0,
    `Expected paise to be a multiple of 1000 (nearest ₹10); got ${estimatedFarePaise}`
  );
  assert.strictEqual(estimatedFarePaise, 244000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Input validation: calculateCommission and calculateFare must throw
//             descriptively on bad inputs rather than returning NaN or silently
//             using incorrect defaults.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Input validation: distanceKm ─────────────────────────────────────────');

run('negative distance throws', () => {
  assert.throws(() => calculateCommission(-1, C), /finite non-negative/);
});

run('NaN distance throws', () => {
  assert.throws(() => calculateCommission(NaN, C), /finite non-negative/);
});

run('Infinity distance throws', () => {
  assert.throws(() => calculateCommission(Infinity, C), /finite non-negative/);
});

run('-Infinity distance throws', () => {
  assert.throws(() => calculateCommission(-Infinity, C), /finite non-negative/);
});

run('string distance throws', () => {
  assert.throws(() => calculateCommission('10', C), /finite non-negative/);
});

console.log('\n── Input validation: serviceType ────────────────────────────────────────');

run("null serviceType throws (not silently mapped to 'standard')", () => {
  assert.throws(() => calculateFare(5, null, 10, C), /serviceType/);
});

run("'tochan' serviceType throws (not a pricing class)", () => {
  assert.throws(() => calculateFare(5, 'tochan', 10, C), /serviceType/);
});

run("undefined serviceType throws", () => {
  assert.throws(() => calculateFare(5, undefined, 10, C), /serviceType/);
});

run("empty string serviceType throws", () => {
  assert.throws(() => calculateFare(5, '', 10, C), /serviceType/);
});

console.log('\n── Input validation: departureHourIst ───────────────────────────────────');

run('null departureHourIst throws (must not silently disable night surge)', () => {
  assert.throws(() => calculateFare(5, 'standard', null, C), /departureHourIst/);
});

run('undefined departureHourIst throws', () => {
  assert.throws(() => calculateFare(5, 'standard', undefined, C), /departureHourIst/);
});

run('fractional hour (6.5) throws', () => {
  assert.throws(() => calculateFare(5, 'standard', 6.5, C), /departureHourIst/);
});

run('hour -1 throws', () => {
  assert.throws(() => calculateFare(5, 'standard', -1, C), /departureHourIst/);
});

run('hour 24 throws', () => {
  assert.throws(() => calculateFare(5, 'standard', 24, C), /departureHourIst/);
});

run('string hour throws', () => {
  assert.throws(() => calculateFare(5, 'standard', '10', C), /departureHourIst/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Config validation: validateConfig (and indirectly both pure
//             functions) must throw descriptively on malformed config.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Config validation ────────────────────────────────────────────────────');

run('null config throws', () => {
  assert.throws(() => validateConfig(null), /non-null object/);
});

run('missing booking_tiers throws', () => {
  assert.throws(() => validateConfig({ fare_formula: C.fare_formula }), /booking_tiers/);
});

run('missing fare_formula throws', () => {
  assert.throws(() => validateConfig({ booking_tiers: C.booking_tiers }), /fare_formula/);
});

run('missing booking_tiers field (per_km_overage_rate) throws', () => {
  const bad = { ...C, booking_tiers: { ...C.booking_tiers, per_km_overage_rate: undefined } };
  assert.throws(() => validateConfig(bad), /per_km_overage_rate/);
});

run('NaN in fare_formula (per_km_rate) throws', () => {
  const bad = { ...C, fare_formula: { ...C.fare_formula, per_km_rate: NaN } };
  assert.throws(() => validateConfig(bad), /per_km_rate/);
});

run('string in fare_formula (road_curvature_factor) throws', () => {
  const bad = { ...C, fare_formula: { ...C.fare_formula, road_curvature_factor: '1.3' } };
  assert.throws(() => validateConfig(bad), /road_curvature_factor/);
});

run('inverted tier ordering (short >= long) throws', () => {
  const bad = {
    ...C,
    booking_tiers: { ...C.booking_tiers, short_distance_limit_km: 15, long_distance_limit_km: 10 },
  };
  assert.throws(() => validateConfig(bad), /tier ordering invalid/);
});

run('round_to_nearest of 0 throws', () => {
  const bad = { ...C, fare_formula: { ...C.fare_formula, round_to_nearest: 0 } };
  assert.throws(() => validateConfig(bad), /round_to_nearest/);
});

run('negative round_to_nearest (-10) throws', () => {
  const bad = { ...C, fare_formula: { ...C.fare_formula, round_to_nearest: -10 } };
  assert.throws(() => validateConfig(bad), /round_to_nearest/);
});

run('Infinity in config throws', () => {
  const bad = { ...C, booking_tiers: { ...C.booking_tiers, tier1_booking_fee: Infinity } };
  assert.throws(() => validateConfig(bad), /tier1_booking_fee/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────────────────────────`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`────────────────────────────────────────────────────────────────────────\n`);

if (failed > 0) {
  process.exit(1);
}
