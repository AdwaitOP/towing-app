'use strict';

/**
 * Fare Calculation Module — Towing Dispatch System
 * Phase 2
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec reference: towing_dispatch_spec_v9.md §Fare Calculation Module, §pricing_config
 *
 * This module is the SINGLE implementation of both pricing formulas:
 *
 *   1. Estimated tow fare — informational only; the customer pays the driver
 *      directly on completion. NEVER collected by the platform. Routing this
 *      amount through the platform would violate the revenue model and trigger
 *      RBI Payment Aggregator / escrow regulatory scope.
 *
 *   2. Booking fee + driver commission — the only amounts the platform collects.
 *      Booking fee: charged to the customer.
 *      Driver commission: deducted from the driver's prepaid wallet on acceptance.
 *
 * ── Monetary units ───────────────────────────────────────────────────────────
 * ALL monetary outputs are integer paise (INR × 100).
 *   bookingFeePaise       — platform fee charged to customer
 *   driverCommissionPaise — amount deducted from driver wallet on acceptance
 *   estimatedFarePaise    — informational; rounded to nearest round_to_nearest
 *                           INR (config), then expressed in paise
 *
 * Config values in Firestore are stored in human-readable INR.
 * This module converts to paise on output.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *   calculateCommission(distanceKm, config)
 *     Pure function. Returns { tier, bookingFeePaise, driverCommissionPaise }.
 *
 *   calculateFare(distanceKm, serviceType, departureHourIst, config)
 *     Pure function. Returns { estimatedFarePaise, isNight, isHighway }.
 *
 *   getPricingConfig()
 *     Async. Reads pricing_config/main from Firestore with ~5 min cache.
 *     Returns the validated config object. Strips underscore-prefixed metadata
 *     keys (e.g. _comment, _note) before validation — seed files contain these.
 *
 *   validateConfig(config)
 *     Validates a config object. Throws descriptively on any missing or
 *     non-numeric required field, or logically invalid constraint (e.g. inverted
 *     tier ordering). Exported for use in tests and by callers that want to
 *     pre-validate a config before passing it to the pure functions.
 *
 * ── Firebase lazy-loading ─────────────────────────────────────────────────────
 * Firebase Admin is required() ONLY inside getPricingConfig(), never at module
 * load time. Importing this file for offline unit tests of the pure functions
 * produces NO Firebase side effects — no initializeApp(), no Firestore calls.
 */

// ── Module-level cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _configCache = null;
let _cacheTimestamp = 0;

// ── Valid service types ──────────────────────────────────────────────────────
// Determines which base fare to use in the fare estimate.
//   'standard' → fare_formula.base_fare_standard
//   'flatbed'  → fare_formula.base_fare_flatbed
//
// How a customer's vehicle selection in Phase 3 maps to a serviceType is
// determined when Phase 3 is designed; that mapping does NOT live here.
const VALID_SERVICE_TYPES = ['standard', 'flatbed'];

// ── Validation helpers ───────────────────────────────────────────────────────

/**
 * Asserts that value is a finite number >= 0.
 * Rejects NaN, ±Infinity, negative values, and non-numbers.
 * @param {*} value
 * @param {string} name  Used in the error message.
 */
function assertFiniteNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `${name} must be a finite non-negative number; got ${JSON.stringify(value)}`
    );
  }
}

/**
 * Asserts that a config field value is a finite number.
 * Rejects NaN, ±Infinity, strings, undefined, null.
 * @param {*} value
 * @param {string} fieldPath  Dotted path used in the error message.
 */
function assertNumericField(value, fieldPath) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `Config field '${fieldPath}' must be a finite number; got ${JSON.stringify(value)}`
    );
  }
}

// ── Config validation ────────────────────────────────────────────────────────

/**
 * Validates a pricing config object.
 *
 * Checks that every field required by calculateCommission and calculateFare is
 * present, is a finite number, and that structural constraints (tier ordering,
 * positive round_to_nearest) are satisfied.
 *
 * Called automatically by calculateCommission and calculateFare, and by
 * getPricingConfig after fetching from Firestore.
 *
 * @param {object} config
 * @throws {TypeError}  If any required field is missing or non-numeric.
 * @throws {RangeError} If a structural constraint is violated.
 */
function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be a non-null object');
  }

  const { booking_tiers: t, fare_formula: f } = config;

  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    throw new TypeError("config.booking_tiers must be a non-null object");
  }
  if (f === null || typeof f !== 'object' || Array.isArray(f)) {
    throw new TypeError("config.fare_formula must be a non-null object");
  }

  // ── booking_tiers ────────────────────────────────────────────────────────
  assertNumericField(t.short_distance_limit_km,      'booking_tiers.short_distance_limit_km');
  assertNumericField(t.long_distance_limit_km,       'booking_tiers.long_distance_limit_km');
  assertNumericField(t.tier1_booking_fee,            'booking_tiers.tier1_booking_fee');
  assertNumericField(t.tier1_driver_commission,      'booking_tiers.tier1_driver_commission');
  assertNumericField(t.tier2_booking_fee,            'booking_tiers.tier2_booking_fee');
  assertNumericField(t.tier2_driver_commission,      'booking_tiers.tier2_driver_commission');
  assertNumericField(t.tier3_booking_fee,            'booking_tiers.tier3_booking_fee');
  assertNumericField(t.tier3_driver_commission_base, 'booking_tiers.tier3_driver_commission_base');
  assertNumericField(t.per_km_overage_rate,          'booking_tiers.per_km_overage_rate');

  if (t.short_distance_limit_km >= t.long_distance_limit_km) {
    throw new RangeError(
      `booking_tiers tier ordering invalid: short_distance_limit_km ` +
      `(${t.short_distance_limit_km}) must be less than long_distance_limit_km ` +
      `(${t.long_distance_limit_km})`
    );
  }

  // ── fare_formula ─────────────────────────────────────────────────────────
  assertNumericField(f.base_fare_standard,             'fare_formula.base_fare_standard');
  assertNumericField(f.base_fare_flatbed,              'fare_formula.base_fare_flatbed');
  assertNumericField(f.per_km_rate,                    'fare_formula.per_km_rate');
  assertNumericField(f.road_curvature_factor,          'fare_formula.road_curvature_factor');
  assertNumericField(f.night_surge_multiplier,         'fare_formula.night_surge_multiplier');
  assertNumericField(f.night_surge_start_hour,         'fare_formula.night_surge_start_hour');
  assertNumericField(f.night_surge_end_hour,           'fare_formula.night_surge_end_hour');
  assertNumericField(f.highway_surge_multiplier,       'fare_formula.highway_surge_multiplier');
  assertNumericField(f.highway_distance_threshold_km,  'fare_formula.highway_distance_threshold_km');
  assertNumericField(f.round_to_nearest,               'fare_formula.round_to_nearest');

  if (f.round_to_nearest <= 0) {
    throw new RangeError(
      `fare_formula.round_to_nearest must be a positive number; got ${f.round_to_nearest}`
    );
  }
}

// ── Pure calculation functions ───────────────────────────────────────────────

/**
 * Determines the booking tier for a job and returns the platform fees.
 *
 * Tier rules (boundaries are inclusive at the lower tier):
 *   Tier 1: distanceKm <= booking_tiers.short_distance_limit_km  (default 10 km)
 *   Tier 2: short_distance_limit_km < distanceKm <= long_distance_limit_km  (default 10–15 km]
 *   Tier 3: distanceKm > long_distance_limit_km  (default > 15 km)
 *
 * Tier 3 driver commission formula (from spec):
 *   commission = tier3_driver_commission_base + per_km_overage_rate × (distanceKm − long_distance_limit_km)
 *
 * @param {number} distanceKm  Haversine straight-line distance in km. Must be a finite number >= 0.
 * @param {object} config      Pricing config from getPricingConfig() or an inline object (tests).
 *
 * @returns {{
 *   tier: 1 | 2 | 3,
 *   bookingFeePaise: number,
 *   driverCommissionPaise: number
 * }}
 * All monetary values are integer paise (INR × 100).
 *
 * @throws {TypeError}  On invalid distanceKm or config.
 * @throws {RangeError} On invalid config constraints.
 */
function calculateCommission(distanceKm, config) {
  assertFiniteNonNegative(distanceKm, 'distanceKm');
  validateConfig(config);

  const t = config.booking_tiers;

  let tier;
  let bookingFeeInr;
  let driverCommissionInr;

  if (distanceKm <= t.short_distance_limit_km) {
    tier = 1;
    bookingFeeInr = t.tier1_booking_fee;
    driverCommissionInr = t.tier1_driver_commission;
  } else if (distanceKm <= t.long_distance_limit_km) {
    tier = 2;
    bookingFeeInr = t.tier2_booking_fee;
    driverCommissionInr = t.tier2_driver_commission;
  } else {
    tier = 3;
    bookingFeeInr = t.tier3_booking_fee;
    const overageKm = distanceKm - t.long_distance_limit_km;
    driverCommissionInr = t.tier3_driver_commission_base + (t.per_km_overage_rate * overageKm);
  }

  return {
    tier,
    bookingFeePaise: Math.round(bookingFeeInr * 100),
    driverCommissionPaise: Math.round(driverCommissionInr * 100),
  };
}

/**
 * Calculates the informational estimated tow fare.
 *
 * !! CRITICAL: This amount is NEVER collected by the platform. !!
 * It is shown to the customer as an estimate of what they will pay the driver
 * directly on job completion. Collecting or routing this through the platform
 * would violate the revenue model and trigger RBI Payment Aggregator scope.
 *
 * Fare formula (Phase 2 pricing rule):
 *   fare = (baseFare + distanceKm × per_km_rate) × road_curvature_factor
 *          × [night_surge_multiplier   if hour is in the night window]
 *          × [highway_surge_multiplier if distanceKm > highway_distance_threshold_km]
 *
 *   road_curvature_factor: multiplied across the whole fare because actual road
 *   distance is longer than the straight-line Haversine distance. Applied before surges.
 *
 *   Night window (using config defaults):
 *     hour >= 22 (night_surge_start_hour, inclusive) OR hour < 6 (night_surge_end_hour, exclusive)
 *     → hours 22, 23, 0, 1, 2, 3, 4, 5 receive the night multiplier
 *     → hour 6 does NOT receive the night multiplier
 *
 *   Highway threshold: strictly greater than highway_distance_threshold_km (default 20 km).
 *     At exactly 20 km: no highway surge. At 20.001 km: highway surge applies.
 *
 *   Surge stacking (Phase 2 pricing rule): when BOTH night and highway conditions
 *   are true, both multipliers are applied multiplicatively:
 *     fare × night_surge_multiplier × highway_surge_multiplier
 *
 *   Final rounding: rounded to the nearest round_to_nearest INR (default ₹10),
 *   then converted to paise. E.g. ₹2437.50 → ₹2440 → 244000 paise.
 *
 * @param {number}            distanceKm       Haversine straight-line km. Finite number >= 0.
 * @param {'standard'|'flatbed'} serviceType   Pricing class of the tow service.
 *                                              'standard' → base_fare_standard.
 *                                              'flatbed'  → base_fare_flatbed.
 *                                              Any other value throws — never silently falls back.
 * @param {number}            departureHourIst Integer in [0, 23]. The IST hour of departure.
 *                                              Must be provided explicitly. Null/undefined throws
 *                                              to prevent silently under-quoting nighttime jobs.
 * @param {object}            config           Pricing config from getPricingConfig() or inline.
 *
 * @returns {{
 *   estimatedFarePaise: number,
 *   isNight: boolean,
 *   isHighway: boolean
 * }}
 * estimatedFarePaise is an integer (paise).
 * isNight and isHighway indicate which surges were applied — useful for logging/audit.
 *
 * @throws {TypeError}  On invalid inputs or config.
 * @throws {RangeError} On invalid config constraints.
 */
function calculateFare(distanceKm, serviceType, departureHourIst, config) {
  // ── Input validation ────────────────────────────────────────────────────
  assertFiniteNonNegative(distanceKm, 'distanceKm');

  if (!VALID_SERVICE_TYPES.includes(serviceType)) {
    throw new TypeError(
      `serviceType must be 'standard' or 'flatbed'; got ${JSON.stringify(serviceType)}`
    );
  }

  if (
    typeof departureHourIst !== 'number' ||
    !Number.isInteger(departureHourIst) ||
    departureHourIst < 0 ||
    departureHourIst > 23
  ) {
    throw new TypeError(
      `departureHourIst must be an integer in [0, 23]; got ${JSON.stringify(departureHourIst)}`
    );
  }

  validateConfig(config);

  // ── Calculation ─────────────────────────────────────────────────────────
  const f = config.fare_formula;

  // Base fare is determined by service type, not by the assigned driver's truck.
  // The mapping from a customer's vehicle selection to serviceType is determined
  // in Phase 3; this module only knows 'standard' and 'flatbed'.
  const baseFareInr = serviceType === 'flatbed' ? f.base_fare_flatbed : f.base_fare_standard;

  // Core: (base fare + distance component) × road curvature factor
  let fareInr = (baseFareInr + distanceKm * f.per_km_rate) * f.road_curvature_factor;

  // Night surge: hour >= start (22, inclusive) OR hour < end (6, exclusive)
  const isNight =
    departureHourIst >= f.night_surge_start_hour ||
    departureHourIst < f.night_surge_end_hour;
  if (isNight) {
    fareInr *= f.night_surge_multiplier;
  }

  // Highway surge: distance strictly exceeds threshold (default 20 km)
  // Phase 2 pricing rule: stacks multiplicatively with night surge when both apply.
  const isHighway = distanceKm > f.highway_distance_threshold_km;
  if (isHighway) {
    fareInr *= f.highway_surge_multiplier;
  }

  // Round to nearest round_to_nearest INR (default ₹10), then convert to paise
  const roundedFareInr = Math.round(fareInr / f.round_to_nearest) * f.round_to_nearest;
  const estimatedFarePaise = Math.round(roundedFareInr * 100);

  return {
    estimatedFarePaise,
    isNight,
    isHighway,
  };
}

// ── Firestore config with cache ──────────────────────────────────────────────

/**
 * Reads and validates pricing_config/main from Firestore.
 * Caches the result for CACHE_TTL_MS (5 minutes) to minimise Firestore reads.
 * The cache is process-scoped: each Cloud Function warm-start reuses it;
 * cold starts perform one read.
 *
 * Metadata keys starting with '_' are stripped before validation.
 * Seed files (firebase/seed/pricing_config.json) contain _comment, _note,
 * _tier3_formula_note, etc. as annotations. These must not reach the calculator.
 *
 * Firebase Admin is lazy-loaded here. Requiring this file for offline tests
 * of calculateCommission / calculateFare has NO Firebase side effects.
 *
 * @returns {Promise<object>} Validated, metadata-stripped pricing config.
 * @throws If Firestore read fails, the document does not exist, or the config
 *         fails validation (see validateConfig).
 */
async function getPricingConfig() {
  if (_configCache !== null && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _configCache;
  }

  // Lazy-load: only executed when Firestore access is needed.
  // NOT executed when this module is required for offline unit tests.
  require('./config/adminInit');
  const { getFirestore } = require('firebase-admin/firestore');

  const db = getFirestore();
  let snap;
  try {
    snap = await db.doc('pricing_config/main').get();
  } catch (err) {
    throw new Error(
      `[fareCalculator] Failed to read pricing_config/main from Firestore: ${err.message}`
    );
  }

  if (!snap.exists) {
    throw new Error(
      '[fareCalculator] PRICING_CONFIG_NOT_FOUND: pricing_config/main does not exist. ' +
      'Seed the document from firebase/seed/pricing_config.json before running.'
    );
  }

  const config = _stripMetadataKeys(snap.data());

  validateConfig(config); // throws with a descriptive message if config is malformed

  _configCache = _deepFreeze(config);
  _cacheTimestamp = Date.now();
  return _configCache;
}

/**
 * Recursively freezes an object and its nested properties to guarantee immutability.
 *
 * @param {*} obj
 * @returns {*}
 */
function _deepFreeze(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    _deepFreeze(val);
  }
  return obj;
}

/**
 * Recursively removes keys starting with '_' from a plain object.
 * Non-object values and arrays are returned as-is.
 *
 * @param {*} value
 * @returns {*}
 */
function _stripMetadataKeys(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    result[key] = _stripMetadataKeys(val);
  }
  return result;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  calculateCommission,
  calculateFare,
  getPricingConfig,
  validateConfig,
};
