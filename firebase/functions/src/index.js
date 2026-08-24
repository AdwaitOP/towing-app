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

// ── Phase 3 (placeholder — uncomment when Phase 3 is implemented) ────────────
// const { whatsappWebhook } = require('./messaging/whatsappWebhook');
// const { driverOtpSend } = require('./messaging/driverOtpSend');
// const { driverOtpVerify } = require('./messaging/driverOtpVerify');
// const { razorpayWebhook } = require('./payments/razorpayWebhook');
// exports.whatsappWebhook = whatsappWebhook;
// exports.driverOtpSend = driverOtpSend;
// exports.driverOtpVerify = driverOtpVerify;
// exports.razorpayWebhook = razorpayWebhook;

// ── Phase 4 (placeholder) ────────────────────────────────────────────────────
// const { acceptJob } = require('./dispatch/acceptJob');
// const { cancelJob } = require('./dispatch/cancelJob');
// const { offerTimeout } = require('./dispatch/offerTimeout');
// exports.acceptJob = acceptJob;
// exports.cancelJob = cancelJob;
// exports.offerTimeout = offerTimeout;

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
