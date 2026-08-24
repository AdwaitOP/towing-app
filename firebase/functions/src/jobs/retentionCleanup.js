'use strict';

/**
 * DPDP Act Retention Cleanup — Phase 1 Stub
 * ─────────────────────────────────────────────────────────────────────────────
 * Spec reference: towing_dispatch_spec_v9.md §Part 2 (DPDP Act note)
 *
 * Purpose
 * ───────
 * India's Digital Personal Data Protection Act (DPDP Act) — rules notified
 * November 2025 — requires a defined retention period for sensitive personal
 * data. Driver KYC documents (Aadhaar/DL photo, RC photo, selfie) are
 * sensitive personal data under the Act. This function implements the
 * scheduled deletion job that enforces the configured retention window.
 *
 * Phase 1 status: STUB — safe no-op
 * ────────────────────────────────
 * The trigger, Firestore query, and deletion path are fully wired in this
 * file. The actual Storage.file.delete() call is intentionally commented out
 * and gated behind a TODO. This is deliberate:
 *   1. The retention_months value in business_config is currently 0 (no-op
 *      default — see firebase/seed/business_config.json). Deletion will not
 *      be enabled until business_config.retention_policy.retention_months is
 *      set to a legally/operationally decided value.
 *   2. Destructive operations should not be committed as live Phase 1 code
 *      before the business requirement is confirmed.
 *
 * To activate deletion in a later phase:
 *   1. Set business_config.retention_policy.retention_months to a positive
 *      integer (e.g. 6) in Firestore (via the Admin Panel Config Editor,
 *      Phase 6, or directly via the Firebase Console).
 *   2. Uncomment the bucket.file(path).delete() call below.
 *   3. Update this comment block to reflect the new status.
 *
 * Schedule
 * ────────
 * Runs once per day. The function is idempotent: running it multiple times
 * for the same driver in the same period produces the same result.
 *
 * Cost
 * ────
 * One Firestore read per approved driver per day. At this driver-pool scale
 * (Navi Mumbai local fleet) this is well within the free-tier read allowance.
 * The query is filtered server-side (verificationStatus == 'approved' and
 * verificationDocs.submittedAt <= cutoff) so only candidates are fetched.
 */

require('../config/adminInit');

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { logger } = require('firebase-functions');

exports.retentionCleanup = onSchedule(
  {
    schedule: 'every 24 hours',
    timeZone: 'Asia/Kolkata',
    // Run at 02:00 IST — low-traffic window.
    // 'every 24 hours' starts from first deploy time; use a cron expression
    // in Phase N+1 if a fixed daily time is needed:
    // schedule: '0 20 * * *',  // 20:30 UTC = 02:00 IST
  },
  async (_event) => {
    const db = getFirestore();

    // ── Step 1: Read retention configuration ─────────────────────────────────
    let retentionMonths;
    try {
      const configSnap = await db.doc('business_config/main').get();
      if (!configSnap.exists) {
        logger.warn('[retentionCleanup] business_config/main does not exist — skipping.');
        return;
      }
      retentionMonths = configSnap.data()?.retention_policy?.retention_months ?? 0;
    } catch (err) {
      logger.error('[retentionCleanup] Failed to read business_config:', err);
      return;
    }

    // A retention_months of 0 (or negative, or absent) means the policy has
    // not been configured. Return immediately — no queries, no cutoff math,
    // no Storage SDK calls, no deletions.
    if (!retentionMonths || retentionMonths <= 0) {
      logger.info(
        '[retentionCleanup] retention_months is 0 or unset — no deletion performed. ' +
          'Set business_config.retention_policy.retention_months to a positive integer to enable.',
      );
      return;
    }

    // ── Step 2: Calculate cutoff timestamp ───────────────────────────────────
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);
    const cutoffTimestamp = Timestamp.fromDate(cutoffDate);

    logger.info(
      `[retentionCleanup] Retention window: ${retentionMonths} months. ` +
        `Cutoff: ${cutoffDate.toISOString()}`,
    );

    // ── Step 3: Query approved drivers with old verificationDocs ─────────────
    // Only approved drivers are candidates — pending/rejected drivers may still
    // need their docs for re-review. A retention policy for rejected drivers
    // is a separate consideration (TODO: define policy for rejected drivers).
    let candidates;
    try {
      const snap = await db
        .collection('drivers')
        .where('verificationStatus', '==', 'approved')
        .where('verificationDocs.submittedAt', '<=', cutoffTimestamp)
        .get();
      candidates = snap.docs;
    } catch (err) {
      logger.error('[retentionCleanup] Firestore query failed:', err);
      return;
    }

    if (candidates.length === 0) {
      logger.info('[retentionCleanup] No drivers past the retention window. Nothing to do.');
      return;
    }

    logger.info(`[retentionCleanup] Found ${candidates.length} driver(s) past retention window.`);

    // ── Step 4: Delete verification photos ───────────────────────────────────
    // getStorage() is initialized here — only reached when retention_months > 0
    // AND candidates exist. Not called when the function is effectively disabled.
    //
    // TODO (Phase 1 STUB): The deletion calls below are commented out until:
    //   a) retention_months is set to a non-zero value (Step 1 already guards this), AND
    //   b) this function is explicitly activated after legal/business sign-off.
    //
    // To activate, remove the TODO block comment and uncomment the deletions.

    const storage = getStorage();
    const bucket = storage.bucket();
    const photoKeys = ['id.jpg', 'rc.jpg', 'selfie.jpg'];

    for (const driverDoc of candidates) {
      const driverId = driverDoc.id;
      logger.info(`[retentionCleanup] [STUB] Would delete photos for driver: ${driverId}`);

      for (const filename of photoKeys) {
        const path = `driver_verification/${driverId}/${filename}`;
        logger.info(`[retentionCleanup] [STUB] Would delete: ${path}`);

        // TODO: Uncomment the block below to enable actual deletion.
        // ─────────────────────────────────────────────────────────
        // try {
        //   await bucket.file(path).delete({ ignoreNotFound: true });
        //   logger.info(`[retentionCleanup] Deleted ${path}`);
        // } catch (err) {
        //   // Log and continue — do not abort the entire run for one file.
        //   logger.error(`[retentionCleanup] Failed to delete ${path}:`, err);
        // }
        // ─────────────────────────────────────────────────────────
      }

      // TODO: Once deletion is enabled, also update the driver doc to clear
      // verificationDocs URLs (they will be broken Storage links once files
      // are deleted) and record the deletion event in admin_actions.
      // ─────────────────────────────────────────────────────────────────────
      // await db.doc(`drivers/${driverId}`).update({
      //   verificationDocs: null,
      //   updatedAt: Timestamp.now(),
      // });
      // await db.collection('admin_actions').add({
      //   action: 'retention_cleanup',
      //   target: driverId,
      //   reason: `DPDP retention window of ${retentionMonths} months elapsed`,
      //   timestamp: Timestamp.now(),
      //   adminUid: 'system',
      // });
      // ─────────────────────────────────────────────────────────────────────
    }

    logger.info('[retentionCleanup] Stub run complete. No files were deleted.');
  },
);
