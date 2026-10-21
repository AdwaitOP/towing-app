'use strict';

/**
 * TowMitra Phase 6 M2 — Driver Verification Decision Engine (M2-ARCH-1)
 *
 * Implements atomic, idempotent verification decisions for:
 * - adminApproveDriver
 * - adminRejectDriver
 *
 * Enforces:
 * - Fresh server-side authority check on invocation and transaction retries
 * - Strict schema validation on input parameters (UUID v4, ExactTimestamp, booleans, generations, NFC reason)
 * - Review timestamp fences (updatedAt and verificationDocs.submittedAt)
 * - Storage evidence existence, positive size <=10MB, image MIME, exact generation match
 * - Driver application validation, profile non-engagement checks
 * - Atomic Firestore transaction: 5-field driver update, auto-ID admin_actions audit, completed receipt
 * - Safe completed-request replay without redundant writes
 * - Fail-closed error handling with standard HttpsError codes and reason codes
 */

const crypto = require('crypto');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { HttpsError } = require('firebase-functions/v2/https');
const { normalizePhone } = require('../utils/phone');
const { isStrictTimestamp, isValidVerificationDocs } = require('../dispatch/submitDriverVerification');
const { verifyAdminCaller, verifyAdminFresh } = require('./adminAuthorization');

const VALID_TRUCK_TYPES = ['flatbed', 'tochan', 'hydraulic', 'crane'];
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUIRED_DOC_FILES = [
  { key: 'id', filename: 'id.jpg' },
  { key: 'rc', filename: 'rc.jpg' },
  { key: 'selfie', filename: 'selfie.jpg' },
];

function isExactTimestamp(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const keys = Object.keys(val);
  if (keys.length !== 2) return false;
  if (!('seconds' in val) || !('nanoseconds' in val)) return false;
  if (typeof val.seconds !== 'number' || typeof val.nanoseconds !== 'number') return false;
  if (!Number.isSafeInteger(val.seconds) || !Number.isSafeInteger(val.nanoseconds)) return false;
  if (val.seconds < -62135596800 || val.seconds > 253402300799) return false;
  if (val.nanoseconds < 0 || val.nanoseconds > 999999999) return false;
  return true;
}

function isValidDriverUid(uid) {
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 128) return false;
  if (uid.includes('/') || /\s/.test(uid) || /[\u0000-\u001F\u007F-\u009F]/.test(uid)) return false;
  return true;
}

function isValidGeneration(gen) {
  if (typeof gen !== 'string' || !gen.trim() || gen.length > 128) return false;
  if (/[\s\/\\?#@\u0000-\u001F\u007F-\u009F]/.test(gen)) return false;
  return true;
}

function validateNormalizedReason(rawReason) {
  if (typeof rawReason !== 'string') {
    throw new HttpsError('invalid-argument', 'Rejection reason must be a string', { reasonCode: 'INVALID_REASON' });
  }
  const normalized = rawReason.normalize('NFC').trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length < 10 || codePoints.length > 500) {
    throw new HttpsError('invalid-argument', 'Rejection reason must be between 10 and 500 characters', { reasonCode: 'INVALID_REASON' });
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(normalized)) {
    throw new HttpsError('invalid-argument', 'Rejection reason contains disallowed control characters', { reasonCode: 'INVALID_REASON' });
  }
  return normalized;
}

function computeReceiptDocId(actorUid, requestId) {
  return 'm2_verify_' + crypto.createHash('sha256')
    .update(JSON.stringify(['phase6_m2_verification', actorUid, requestId]), 'utf8')
    .digest('hex');
}

function computePayloadHash({ operation, driverUid, expectedUpdatedAt, expectedSubmittedAt, decisionValues }) {
  const canonicalArray = [
    'M2-ARCH-1',
    operation,
    driverUid,
    [expectedUpdatedAt.seconds, expectedUpdatedAt.nanoseconds],
    [expectedSubmittedAt.seconds, expectedSubmittedAt.nanoseconds],
    decisionValues,
  ];
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalArray), 'utf8')
    .digest('hex');
}

function createDecisionManager({
  db = null,
  auth = null,
  storage = null,
  TimestampClass = Timestamp,
  FieldValueClass = FieldValue,
  bucket = null,
} = {}) {
  const firestoreDb = db || getFirestore();

  async function executeDecision({ operation, request }) {
    if (operation !== 'adminApproveDriver' && operation !== 'adminRejectDriver') {
      throw new HttpsError('invalid-argument', `Unknown operation: ${operation}`);
    }

    // 1. Authorize admin caller (checks callable auth, ID token revocation, fresh user claims)
    const { uid: actorUid, token } = await verifyAdminCaller({ request, auth });

    // 2. Validate request payload strictly against allowlists
    const data = request.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpsError('invalid-argument', 'Request data must be an object');
    }

    const dataKeys = Object.keys(data);
    const expectedApproveKeys = [
      'requestId',
      'driverUid',
      'expectedUpdatedAt',
      'expectedSubmittedAt',
      'canFlatbed',
      'canPulling',
      'expectedObjectGenerations',
    ];
    const expectedRejectKeys = [
      'requestId',
      'driverUid',
      'expectedUpdatedAt',
      'expectedSubmittedAt',
      'reason',
    ];
    const allowedKeys = operation === 'adminApproveDriver' ? expectedApproveKeys : expectedRejectKeys;

    if (dataKeys.length !== allowedKeys.length || !allowedKeys.every((k) => dataKeys.includes(k))) {
      throw new HttpsError('invalid-argument', 'Request contains unexpected or missing keys');
    }

    const { requestId, driverUid, expectedUpdatedAt, expectedSubmittedAt } = data;

    if (typeof requestId !== 'string' || !UUID_V4_REGEX.test(requestId)) {
      throw new HttpsError('invalid-argument', 'requestId must be a lowercase canonical UUID v4');
    }

    if (!isValidDriverUid(driverUid)) {
      throw new HttpsError('invalid-argument', 'Invalid driver UID format');
    }

    if (!isExactTimestamp(expectedUpdatedAt) || !isExactTimestamp(expectedSubmittedAt)) {
      throw new HttpsError('invalid-argument', 'Expected review timestamps must be exact seconds and nanoseconds');
    }

    let canFlatbed = null;
    let canPulling = null;
    let expectedObjectGenerations = null;
    let normalizedReason = null;

    if (operation === 'adminApproveDriver') {
      canFlatbed = data.canFlatbed;
      canPulling = data.canPulling;
      if (typeof canFlatbed !== 'boolean' || typeof canPulling !== 'boolean') {
        throw new HttpsError('invalid-argument', 'canFlatbed and canPulling must be literal booleans');
      }
      if (!canFlatbed && !canPulling) {
        throw new HttpsError('invalid-argument', 'At least one capability (canFlatbed or canPulling) must be true');
      }

      expectedObjectGenerations = data.expectedObjectGenerations;
      if (
        !expectedObjectGenerations ||
        typeof expectedObjectGenerations !== 'object' ||
        Array.isArray(expectedObjectGenerations)
      ) {
        throw new HttpsError('invalid-argument', 'expectedObjectGenerations must be an object');
      }
      const genKeys = Object.keys(expectedObjectGenerations);
      if (genKeys.length !== 3 || !['id', 'rc', 'selfie'].every((k) => genKeys.includes(k))) {
        throw new HttpsError('invalid-argument', 'expectedObjectGenerations must have exactly id, rc, and selfie');
      }
      for (const k of ['id', 'rc', 'selfie']) {
        if (!isValidGeneration(expectedObjectGenerations[k])) {
          throw new HttpsError('invalid-argument', `Invalid object generation string for ${k}`);
        }
      }
    } else {
      normalizedReason = validateNormalizedReason(data.reason);
    }

    // 3. Resolve storage bucket
    let targetBucket = bucket;
    if (!targetBucket) {
      const defaultBucketName = process.env.FIREBASE_STORAGE_BUCKET || (process.env.GCLOUD_PROJECT ? `${process.env.GCLOUD_PROJECT}.appspot.com` : 'demo-towmitra-admin.appspot.com');
      const targetStorage = storage || (typeof getStorage === 'function' ? getStorage() : null);
      try {
        targetBucket = targetStorage && typeof targetStorage.bucket === 'function' ? targetStorage.bucket(defaultBucketName) : null;
      } catch (_) {
        targetBucket = null;
      }
    }
    if (!targetBucket) {
      throw new HttpsError('internal', 'Firebase Storage bucket unavailable');
    }
    const bucketName = targetBucket.name || process.env.FIREBASE_STORAGE_BUCKET || (process.env.GCLOUD_PROJECT ? `${process.env.GCLOUD_PROJECT}.appspot.com` : 'demo-towmitra-admin.appspot.com');

    // 4. Compute deterministic receipt ID & payload hash
    const receiptDocId = computeReceiptDocId(actorUid, requestId);
    const decisionValues = operation === 'adminApproveDriver'
      ? [canFlatbed, canPulling, expectedObjectGenerations.id, expectedObjectGenerations.rc, expectedObjectGenerations.selfie]
      : [normalizedReason];
    const payloadHash = computePayloadHash({
      operation,
      driverUid,
      expectedUpdatedAt,
      expectedSubmittedAt,
      decisionValues,
    });

    // 5. Pre-allocate one auto-ID admin_actions reference outside transaction retries
    const actionRef = firestoreDb.collection('admin_actions').doc();
    const actionId = actionRef.id;

    // 6. Run atomic Firestore transaction
    return await firestoreDb.runTransaction(async (transaction) => {
      // 6a. Fresh authority check on every transaction attempt
      await verifyAdminFresh({ uid: actorUid, token, auth });

      // 6b. Read completed receipt first
      const receiptRef = firestoreDb.collection('processed_requests').doc(receiptDocId);
      const receiptSnap = await transaction.get(receiptRef);

      if (receiptSnap.exists) {
        const receipt = receiptSnap.data() || {};
        if (
          receipt.status === 'completed' &&
          receipt.actorUid === actorUid &&
          receipt.operation === operation &&
          receipt.resourceId === driverUid &&
          receipt.payloadHash === payloadHash
        ) {
          const res = receipt.result;
          const isValidResult =
            res &&
            typeof res === 'object' &&
            res.success === true &&
            res.driverUid === driverUid &&
            res.verificationStatus === (operation === 'adminApproveDriver' ? 'approved' : 'rejected') &&
            typeof res.actionId === 'string' &&
            res.actionId.length > 0 &&
            /^[A-Za-z0-9_-]+$/.test(res.actionId) &&
            res.reviewedSubmittedAt &&
            typeof res.reviewedSubmittedAt === 'object' &&
            res.reviewedSubmittedAt.seconds === expectedSubmittedAt.seconds &&
            res.reviewedSubmittedAt.nanoseconds === expectedSubmittedAt.nanoseconds;

          const hasValidTimestamps =
            isStrictTimestamp(receipt.createdAt, TimestampClass) &&
            isStrictTimestamp(receipt.completedAt, TimestampClass);

          if (!isValidResult || !hasValidTimestamps) {
            throw new HttpsError(
              'failed-precondition',
              'Completed receipt is malformed or mismatched',
              { reasonCode: 'MALFORMED_COMPLETED_RECEIPT' }
            );
          }

          // Idempotent exact replay: zero writes, return original committed result
          return {
            ...res,
            replayed: true,
          };
        }
        // Conflict / reused ID with different payload or operation
        throw new HttpsError(
          'failed-precondition',
          'Request ID reused for different operation, target, or payload',
          { reasonCode: 'REQUEST_ID_REUSED' }
        );
      }

      // 6c. Read current driver application
      const driverRef = firestoreDb.collection('drivers').doc(driverUid);
      const driverSnap = await transaction.get(driverRef);

      if (!driverSnap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driverData = driverSnap.data() || {};

      // 6d. Validate driver data and current pending state
      if (!('uid' in driverData) || driverData.uid === null || typeof driverData.uid !== 'string' || !driverData.uid.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile UID is missing or invalid', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (driverData.uid !== driverUid) {
        throw new HttpsError('failed-precondition', 'Driver profile UID does not match document ID', { reasonCode: 'APPLICATION_INVALID' });
      }

      const currentStatus = driverData.verificationStatus;
      if (currentStatus !== 'pending') {
        if (currentStatus === 'approved' || currentStatus === 'rejected') {
          throw new HttpsError('failed-precondition', 'Driver application is already decided', { reasonCode: 'ALREADY_DECIDED' });
        }
        throw new HttpsError('failed-precondition', 'Driver application is not pending', { reasonCode: 'APPLICATION_INVALID' });
      }

      // 6e. Validate exact review timestamp fences
      if (!isStrictTimestamp(driverData.updatedAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile updatedAt is missing or invalid', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (
        driverData.updatedAt.seconds !== expectedUpdatedAt.seconds ||
        driverData.updatedAt.nanoseconds !== expectedUpdatedAt.nanoseconds
      ) {
        throw new HttpsError('failed-precondition', 'Application was updated since review', { reasonCode: 'STALE_APPLICATION' });
      }

      if (!driverData.verificationDocs || !isStrictTimestamp(driverData.verificationDocs.submittedAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Application submittedAt is missing or invalid', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (
        driverData.verificationDocs.submittedAt.seconds !== expectedSubmittedAt.seconds ||
        driverData.verificationDocs.submittedAt.nanoseconds !== expectedSubmittedAt.nanoseconds
      ) {
        throw new HttpsError('failed-precondition', 'Application submittedAt changed since review', { reasonCode: 'STALE_APPLICATION' });
      }

      // 6f. Validate required profile fields
      if (!driverData.name || typeof driverData.name !== 'string' || !driverData.name.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile name is missing or blank', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (!driverData.vehicleNumber || typeof driverData.vehicleNumber !== 'string' || !driverData.vehicleNumber.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile vehicleNumber is missing or blank', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (!driverData.phone || typeof driverData.phone !== 'string') {
        throw new HttpsError('failed-precondition', 'Driver profile phone number is missing', { reasonCode: 'APPLICATION_INVALID' });
      }
      try {
        normalizePhone(driverData.phone);
      } catch (_) {
        throw new HttpsError('failed-precondition', 'Driver profile phone number is invalid', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (!driverData.truckType || typeof driverData.truckType !== 'string' || !VALID_TRUCK_TYPES.includes(driverData.truckType)) {
        throw new HttpsError('failed-precondition', 'Driver application has invalid truckType', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (!isStrictTimestamp(driverData.createdAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile createdAt is missing or invalid', { reasonCode: 'APPLICATION_INVALID' });
      }
      if (typeof driverData.isOnDuty !== 'boolean' || driverData.isOnDuty !== false) {
        throw new HttpsError('failed-precondition', 'Driver isOnDuty must be boolean false', { reasonCode: 'DRIVER_ENGAGED' });
      }

      // Check non-engagement: allow only absent (undefined) or null
      if (driverData.activeJobId !== undefined && driverData.activeJobId !== null) {
        throw new HttpsError('failed-precondition', 'Driver is actively engaged in a job', { reasonCode: 'DRIVER_ENGAGED' });
      }
      if (driverData.activeOfferId !== undefined && driverData.activeOfferId !== null) {
        throw new HttpsError('failed-precondition', 'Driver is actively engaged in an offer', { reasonCode: 'DRIVER_ENGAGED' });
      }
      if (driverData.dutySessionId !== undefined && driverData.dutySessionId !== null) {
        throw new HttpsError('failed-precondition', 'Driver is actively engaged in a duty session', { reasonCode: 'DRIVER_ENGAGED' });
      }

      // workerReady if present must be literal false
      if ('workerReady' in driverData && driverData.workerReady !== undefined && driverData.workerReady !== false) {
        throw new HttpsError('failed-precondition', 'Driver workerReady is active or malformed', { reasonCode: 'DRIVER_ENGAGED' });
      }

      // Capabilities if present must be booleans
      if ('canFlatbed' in driverData && driverData.canFlatbed !== undefined && typeof driverData.canFlatbed !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver canFlatbed is malformed', { reasonCode: 'APPLICATION_INVALID' });
      }
      if ('canPulling' in driverData && driverData.canPulling !== undefined && typeof driverData.canPulling !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver canPulling is malformed', { reasonCode: 'APPLICATION_INVALID' });
      }

      // Verification docs structure & exact bucket/path
      if (!isValidVerificationDocs(driverData.verificationDocs, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver verificationDocs is malformed', { reasonCode: 'APPLICATION_INVALID' });
      }
      const expectedIdUrl = `gs://${bucketName}/driver_verification/${driverUid}/id.jpg`;
      const expectedRcUrl = `gs://${bucketName}/driver_verification/${driverUid}/rc.jpg`;
      const expectedSelfieUrl = `gs://${bucketName}/driver_verification/${driverUid}/selfie.jpg`;

      if (
        driverData.verificationDocs.idPhotoUrl !== expectedIdUrl ||
        driverData.verificationDocs.rcPhotoUrl !== expectedRcUrl ||
        driverData.verificationDocs.selfiePhotoUrl !== expectedSelfieUrl
      ) {
        throw new HttpsError('failed-precondition', 'Verification documents storage paths do not match canonical contract', { reasonCode: 'APPLICATION_INVALID' });
      }

      if ('rejectionReason' in driverData && driverData.rejectionReason !== null && typeof driverData.rejectionReason !== 'string') {
        throw new HttpsError('failed-precondition', 'Driver rejectionReason is malformed', { reasonCode: 'APPLICATION_INVALID' });
      }

      // 6g. For approval: verify storage objects exist, image MIME, positive size <=10MB, exact generation
      if (operation === 'adminApproveDriver') {
        for (const doc of REQUIRED_DOC_FILES) {
          const filePath = `driver_verification/${driverUid}/${doc.filename}`;
          const file = targetBucket.file(filePath);
          let metadata;
          try {
            const [meta] = await file.getMetadata();
            metadata = meta;
          } catch (err) {
            throw new HttpsError(
              'failed-precondition',
              `Evidence file missing or inaccessible: ${doc.filename}`,
              { reasonCode: 'EVIDENCE_UNAVAILABLE' }
            );
          }

          const generation = String(metadata.generation || '');
          if (!generation || generation !== expectedObjectGenerations[doc.key]) {
            throw new HttpsError(
              'failed-precondition',
              `Evidence generation changed or missing: ${doc.filename}`,
              { reasonCode: 'EVIDENCE_CHANGED' }
            );
          }

          const contentType = String(metadata.contentType || '');
          if (!contentType.startsWith('image/')) {
            throw new HttpsError(
              'failed-precondition',
              `Evidence file has invalid MIME type: ${doc.filename}`,
              { reasonCode: 'EVIDENCE_UNAVAILABLE' }
            );
          }

          const size = Number(metadata.size || 0);
          if (size <= 0 || size > 10 * 1024 * 1024) {
            throw new HttpsError(
              'failed-precondition',
              `Evidence file size invalid: ${doc.filename}`,
              { reasonCode: 'EVIDENCE_UNAVAILABLE' }
            );
          }
        }
      }

      // 6h. Apply writes
      const nowTimestamp = (FieldValueClass && typeof FieldValueClass.serverTimestamp === 'function')
        ? FieldValueClass.serverTimestamp()
        : FieldValue.serverTimestamp();

      const newStatus = operation === 'adminApproveDriver' ? 'approved' : 'rejected';

      // Exactly 5 fields patched on driver profile
      const driverPatch = operation === 'adminApproveDriver'
        ? {
            verificationStatus: 'approved',
            canFlatbed,
            canPulling,
            rejectionReason: null,
            updatedAt: nowTimestamp,
          }
        : {
            verificationStatus: 'rejected',
            canFlatbed: false,
            canPulling: false,
            rejectionReason: normalizedReason,
            updatedAt: nowTimestamp,
          };

      // Audit record (admin_actions/{actionId})
      const auditRecord = {
        adminUid: actorUid,
        action: operation === 'adminApproveDriver' ? 'approve_driver' : 'reject_driver',
        target: driverUid,
        reason: operation === 'adminApproveDriver' ? null : normalizedReason,
        timestamp: nowTimestamp,
        metadata: {
          contractVersion: 'M2-ARCH-1',
          requestId,
          operation,
          payloadHash,
          expectedUpdatedAt: {
            seconds: expectedUpdatedAt.seconds,
            nanoseconds: expectedUpdatedAt.nanoseconds,
          },
          expectedSubmittedAt: {
            seconds: expectedSubmittedAt.seconds,
            nanoseconds: expectedSubmittedAt.nanoseconds,
          },
          oldStatus: driverData.verificationStatus,
          newStatus,
          oldCapabilities: {
            canFlatbed: typeof driverData.canFlatbed === 'boolean' ? driverData.canFlatbed : null,
            canPulling: typeof driverData.canPulling === 'boolean' ? driverData.canPulling : null,
          },
          newCapabilities: operation === 'adminApproveDriver'
            ? { canFlatbed, canPulling }
            : { canFlatbed: false, canPulling: false },
          objectGenerations: operation === 'adminApproveDriver'
            ? {
                id: expectedObjectGenerations.id,
                rc: expectedObjectGenerations.rc,
                selfie: expectedObjectGenerations.selfie,
              }
            : null,
        },
      };

      // Completed receipt (processed_requests/{receiptDocId})
      const resultPayload = {
        success: true,
        driverUid,
        verificationStatus: newStatus,
        reviewedSubmittedAt: {
          seconds: expectedSubmittedAt.seconds,
          nanoseconds: expectedSubmittedAt.nanoseconds,
        },
        actionId,
      };

      const receiptRecord = {
        actorUid,
        operation,
        resourceId: driverUid,
        payloadHash,
        status: 'completed',
        result: resultPayload,
        createdAt: nowTimestamp,
        completedAt: nowTimestamp,
      };

      transaction.update(driverRef, driverPatch);
      transaction.create(actionRef, auditRecord);
      transaction.create(receiptRef, receiptRecord);

      return {
        ...resultPayload,
        replayed: false,
      };
    });
  }

  return {
    executeDecision,
  };
}

module.exports = {
  VALID_TRUCK_TYPES,
  REQUIRED_DOC_FILES,
  isExactTimestamp,
  isValidDriverUid,
  isValidGeneration,
  validateNormalizedReason,
  computeReceiptDocId,
  computePayloadHash,
  createDecisionManager,
};
