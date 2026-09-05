'use strict';

/**
 * Cloud Functions entry point — Towing Dispatch System
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is the single exports aggregation point. The Firebase Functions
 * runtime loads this file and registers every exported function.
 *
 * Phase 1: exports only the DPDP retention cleanup stub.
 * Future phases append exports here as they are implemented:
 *
 *   Phase 2: (no new Cloud Functions — fareCalculator.js is a local module)
 *   Phase 3: whatsappWebhook, driverOtpSend, driverOtpVerify, razorpayWebhook
 *   Phase 4: dispatchJob, acceptJob, cancelJob, offerTimeout (Cloud Task handler)
 *   Phase 6: adminApproveDriver, adminRejectDriver, adminForgiveCancellation,
 *             adminUpdatePricingConfig, adminCreatePhoneBooking
 *
 * Keep this file as a thin re-export aggregator — no business logic lives here.
 */

// ── Phase 1 ─────────────────────────────────────────────────────────────────
const { retentionCleanup } = require('./jobs/retentionCleanup');
exports.retentionCleanup = retentionCleanup;

const { onRequest } = require('firebase-functions/v2/https');

// ── Phase 3 (implemented) ───────────────────────────────────────────────────
const { handleWhatsAppWebhook } = require('./messaging/whatsappWebhook');
const { driverOtpSend } = require('./messaging/driverOtpSend');
const { driverOtpVerify } = require('./messaging/driverOtpVerify');
const { handleRazorpayWebhook } = require('./payments/razorpayWebhook');

exports.whatsappWebhook = onRequest({
  secrets: [
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ACCESS_TOKEN',
    'RAZORPAY_KEY_SECRET',
  ],
}, handleWhatsAppWebhook);
exports.driverOtpSend = onRequest({ secrets: ['OTP_PEPPER', 'WHATSAPP_ACCESS_TOKEN'] }, driverOtpSend);
exports.driverOtpVerify = onRequest({ secrets: ['OTP_PEPPER'] }, driverOtpVerify);
exports.razorpayWebhook = onRequest({
  secrets: ['RAZORPAY_WEBHOOK_SECRET', 'WHATSAPP_ACCESS_TOKEN'],
}, handleRazorpayWebhook);

// ── Phase 4 Stage 2 durable consumer and backlog/retry recovery ───────────────
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { productionRecovery } = require('./dispatch/dispatchRecovery');
const { logger } = require('firebase-functions');

exports.dispatchPendingJob = onDocumentWritten({
  document: 'jobs/{jobId}', retry: true, secrets: ['OLA_MAPS_API_KEY'],
}, async event => {
  const result = await productionRecovery().consumePendingJob(event);
  if (result) logger.info('Dispatch consumer result', {
    dispatched: result.dispatched === true, reason: result.reason || null, state: result.state || null,
  });
});
exports.reconcilePendingDispatch = onSchedule({
  // Required deployment setting: empty is deliberately not a deployable schedule.
  schedule: process.env.DISPATCH_RECONCILE_SCHEDULE || '',
  timeZone: 'Asia/Kolkata', secrets: ['OLA_MAPS_API_KEY'],
}, async () => {
  logger.info('Dispatch recovery result', await productionRecovery().reconcilePendingJobs());
});

// ── Phase 4 Stage 3 offer timeout execution & recovery ───────────────────────
const { offerTimeout } = require('./dispatch/offerTimeout');
exports.offerTimeout = offerTimeout;
exports.reconcileOfferTimeouts = onSchedule({
  schedule: process.env.DISPATCH_TIMEOUT_RECONCILE_SCHEDULE || process.env.DISPATCH_RECONCILE_SCHEDULE || '',
  timeZone: 'Asia/Kolkata', secrets: ['OLA_MAPS_API_KEY'],
}, async () => {
  logger.info('Offer timeout recovery result', await productionRecovery().reconcileOfferTimeouts());
});


// ── Phase 4 Stage 4 driver acceptance & commission debit ─────────────────────
const { acceptJob } = require('./dispatch/acceptJob');
exports.acceptJob = acceptJob;

// ── Phase 4 Stage 5 driver decline & cascade ─────────────────────────────────
const { declineJob } = require('./dispatch/declineJob');
exports.declineJob = declineJob;

// Later Phase 4 stages remain excluded.
// const { cancelJob } = require('./dispatch/cancelJob');
// exports.cancelJob = cancelJob;


// ── Phase 6 (placeholder) ────────────────────────────────────────────────────
// const { adminApproveDriver } = require('./admin/approveDriver');
// const { adminRejectDriver } = require('./admin/rejectDriver');
// const { adminForgiveCancellation } = require('./admin/forgiveCancellation');
// const { adminUpdatePricingConfig } = require('./admin/updatePricingConfig');
// const { adminCreatePhoneBooking } = require('./admin/createPhoneBooking');
// exports.adminApproveDriver = adminApproveDriver;
// exports.adminRejectDriver = adminRejectDriver;
// exports.adminForgiveCancellation = adminForgiveCancellation;
// exports.adminUpdatePricingConfig = adminUpdatePricingConfig;
// exports.adminCreatePhoneBooking = adminCreatePhoneBooking;
