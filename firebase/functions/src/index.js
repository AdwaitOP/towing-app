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

// ── Phase 4 Stage 6 tow lifecycle (startJob + completeJob) ───────────────────
const { startJob, completeJob } = require('./dispatch/jobLifecycle');
exports.startJob = startJob;
exports.completeJob = completeJob;

// ── Phase 4 Stage 7 customer cancellation resolver ───────────────────────────
const {
  productionCustomerCancellationManager,
  shouldProcessCustomerCancellation,
} = require('./dispatch/customerCancellation');

exports.resolveJobCancellation = onDocumentWritten({
  document: 'jobs/{jobId}', retry: true,
}, async event => {
  if (!shouldProcessCustomerCancellation(event)) return;
  const result = await productionCustomerCancellationManager().resolveCustomerCancellation({ jobId: event.params.jobId });
  if (result) logger.info('Customer cancellation resolution result', result);
});

exports.reconcileCustomerCancellations = onSchedule({
  schedule: process.env.CUSTOMER_CANCELLATION_RECONCILE_SCHEDULE || process.env.DISPATCH_RECONCILE_SCHEDULE || '',
  timeZone: 'Asia/Kolkata',
}, async () => {
  logger.info('Customer cancellation sweep result', await productionCustomerCancellationManager().reconcileCustomerCancellations());
});

// ── Phase 4 Stage 8 driver cancellation & forfeiture ramp ────────────────────
const { cancelJob } = require('./dispatch/cancelJob');
exports.cancelJob = cancelJob;

// ── Phase 4 Stage 9 no-driver Razorpay refund ────────────────────────────────
const {
  productionNoDriverRefundManager,
  shouldProcessRefundIntent,
} = require('./dispatch/noDriverRefund');

exports.processRefundIntent = onDocumentWritten({
  document: 'refund_requests/{jobId}', retry: true,
  secrets: ['RAZORPAY_KEY_SECRET'],
}, async event => {
  if (!shouldProcessRefundIntent(event)) return;
  const result = await productionNoDriverRefundManager().processRefundIntent(event.params.jobId);
  if (result) logger.info('Refund intent initiation result', result);
});

exports.reconcileRefunds = onSchedule({
  schedule: process.env.REFUND_RECONCILE_SCHEDULE || process.env.DISPATCH_RECONCILE_SCHEDULE || '',
  timeZone: 'Asia/Kolkata',
  secrets: ['RAZORPAY_KEY_SECRET'],
}, async () => {
  logger.info('Refund sweep result', await productionNoDriverRefundManager().reconcileRefunds());
});


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
