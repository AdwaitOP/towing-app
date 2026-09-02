'use strict';

const { GeoPoint } = require('firebase-admin/firestore');

// Complete Phase 3 paid-job fixtures. Test overrides isolate the defect under
// test instead of accidentally failing an unrelated payment/schema guard.
function paidJob(TimestampClass, nowMs, overrides = {}) {
  return {
    customerPhone: '+919876543210', pickupCoords: { lat: 18.5204, lng: 73.8567 },
    destCoords: { lat: 18.55, lng: 73.88 }, requestedTruckType: 'flatbed', distanceKm: 4.5,
    pricingTier: 1, bookingFeePaise: 10000, driverCommissionPaise: 5000, estimatedFarePaise: 45000,
    status: 'pending_offer', offeredTo: null, assignedDriver: null, channel: 'whatsapp', createdByAdmin: null,
    razorpayPaymentLinkId: 'plink_TEST', razorpayPaymentLinkUrl: 'https://rzp.io/i/test', razorpayPaymentId: 'pay_TEST',
    paymentConfirmedAt: TimestampClass.fromMillis(nowMs - 1000),
    invoiceNumber: null, invoiceUrl: null, invoiceSentAt: null,
    cancellationRequestedAt: null, cancelledBy: null, cancellationReason: null,
    createdAt: TimestampClass.fromMillis(nowMs - 60000), updatedAt: TimestampClass.fromMillis(nowMs - 1000),
    ...overrides,
  };
}
function config(TimestampClass, nowMs, overrides = {}) {
  return {
    version: 1, locationFreshnessSeconds: 120, radiusKmSequence: [10, 20, 35],
    maxUniqueCandidatesPerGeneration: 30, maxMatrixShortlistPerRound: 10,
    rankingPrimary: 'ola_eta_seconds', rankingSecondary: 'ola_distance_meters', rankingTieBreak: 'driver_uid',
    olaFailureMode: 'bounded_retry_then_haversine_degraded', olaMonthlyPairCap: null,
    updatedAt: TimestampClass.fromMillis(nowMs), ...overrides,
  };
}
function driver(TimestampClass, nowMs, overrides = {}) {
  return {
    isOnDuty: true, verificationStatus: 'approved', truckType: 'hydraulic',
    canFlatbed: true, canPulling: false, bannedUntil: null, activeOfferId: null, activeJobId: null,
    walletBalance: 25000, location: new GeoPoint(18.525, 73.86),
    locationUpdatedAt: TimestampClass.fromMillis(nowMs - 1000), ...overrides,
  };
}
function matrixBody(origins = 1, destinations = 1) {
  return { rows: Array.from({ length: origins }, () => ({ elements: Array.from({ length: destinations }, () =>
    ({ status: 'OK', duration: 300, distance: 2000 })) })) };
}
module.exports = { paidJob, config, driver, matrixBody };
