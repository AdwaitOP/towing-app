'use strict';

const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { normalizePhone } = require('../utils/phone');

const VALID_TRUCK_TYPES = ['flatbed', 'tochan', 'hydraulic', 'crane'];
const ALLOWED_VERIFICATION_STATUSES = [null, undefined, 'pending', 'approved', 'rejected'];

const REQUIRED_DOCS = [
  { key: 'idPhotoUrl', filename: 'id.jpg' },
  { key: 'rcPhotoUrl', filename: 'rc.jpg' },
  { key: 'selfiePhotoUrl', filename: 'selfie.jpg' },
];

function isStrictTimestamp(val, TimestampClass) {
  return Boolean(
    val &&
    typeof val === 'object' &&
    TimestampClass &&
    typeof TimestampClass === 'function' &&
    val instanceof TimestampClass
  );
}

function isValidVerificationDocs(docs, TimestampClass) {
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return false;
  const keys = Object.keys(docs);
  const expectedKeys = ['idPhotoUrl', 'rcPhotoUrl', 'selfiePhotoUrl', 'submittedAt'];
  if (keys.length !== 4) return false;
  for (const k of expectedKeys) {
    if (!keys.includes(k)) return false;
  }
  if (typeof docs.idPhotoUrl !== 'string' || !docs.idPhotoUrl.trim()) return false;
  if (typeof docs.rcPhotoUrl !== 'string' || !docs.rcPhotoUrl.trim()) return false;
  if (typeof docs.selfiePhotoUrl !== 'string' || !docs.selfiePhotoUrl.trim()) return false;
  if (!isStrictTimestamp(docs.submittedAt, TimestampClass)) return false;
  return true;
}

function createSubmitDriverVerificationManager({
  db = null,
  storage = null,
  TimestampClass = Timestamp,
  FieldValueClass = FieldValue,
  bucket = null,
} = {}) {
  const firestoreDb = db || getFirestore();

  async function submitDriverVerification({ driverUid } = {}) {
    if (typeof driverUid !== 'string' || !driverUid || driverUid.includes('/')) {
      throw new HttpsError('invalid-argument', 'Invalid driver UID');
    }

    // Resolve storage bucket
    let targetBucket = bucket;
    if (!targetBucket) {
      const targetStorage = storage || (typeof getStorage === 'function' ? getStorage() : null);
      targetBucket = targetStorage && typeof targetStorage.bucket === 'function' ? targetStorage.bucket() : null;
    }
    if (!targetBucket) {
      throw new HttpsError('internal', 'Firebase Storage bucket unavailable');
    }

    const bucketName = targetBucket.name || process.env.FIREBASE_STORAGE_BUCKET || 'default';

    // Verify all 3 required KYC files exist in Firebase Storage BEFORE initiating transaction
    for (const doc of REQUIRED_DOCS) {
      const filePath = `driver_verification/${driverUid}/${doc.filename}`;
      const file = targetBucket.file(filePath);
      const [exists] = await file.exists();
      if (!exists) {
        throw new HttpsError(
          'failed-precondition',
          `Missing required KYC document: ${doc.filename}. All three files (id.jpg, rc.jpg, selfie.jpg) must be uploaded.`
        );
      }
    }

    // Execute atomic Firestore transaction re-reading drivers/{uid}
    return await firestoreDb.runTransaction(async (transaction) => {
      const driverRef = firestoreDb.collection('drivers').doc(driverUid);
      const driverSnap = await transaction.get(driverRef);

      if (!driverSnap.exists) {
        throw new HttpsError('not-found', 'Driver profile does not exist');
      }

      const driverData = driverSnap.data() || {};

      // Validate persisted UID exists, is string, and strictly matches caller
      if (!('uid' in driverData) || driverData.uid === null || typeof driverData.uid !== 'string' || !driverData.uid.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile UID is missing or invalid');
      }
      if (driverData.uid !== driverUid) {
        throw new HttpsError('failed-precondition', 'Driver profile UID does not match document ID');
      }

      // Validate required profile fields
      if (!driverData.name || typeof driverData.name !== 'string' || !driverData.name.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile name is missing or blank');
      }
      if (!driverData.vehicleNumber || typeof driverData.vehicleNumber !== 'string' || !driverData.vehicleNumber.trim()) {
        throw new HttpsError('failed-precondition', 'Driver profile vehicleNumber is missing or blank');
      }

      // Canonical phone validation
      if (!driverData.phone || typeof driverData.phone !== 'string') {
        throw new HttpsError('failed-precondition', 'Driver profile phone number is missing');
      }
      try {
        normalizePhone(driverData.phone);
      } catch (_) {
        throw new HttpsError('failed-precondition', 'Driver profile phone number is invalid');
      }

      // Validate truckType against canonical allowlist
      if (!driverData.truckType || typeof driverData.truckType !== 'string' || !VALID_TRUCK_TYPES.includes(driverData.truckType)) {
        throw new HttpsError('failed-precondition', `Invalid truckType: "${driverData.truckType}". Must be one of: ${VALID_TRUCK_TYPES.join(', ')}`);
      }

      // Strict boolean isOnDuty
      if (typeof driverData.isOnDuty !== 'boolean') {
        throw new HttpsError('failed-precondition', 'Driver profile isOnDuty must be a boolean');
      }

      // Valid Firestore timestamps
      if (!isStrictTimestamp(driverData.createdAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile createdAt is missing or invalid Timestamp');
      }
      if (!isStrictTimestamp(driverData.updatedAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile updatedAt is missing or invalid Timestamp');
      }

      // Check optional timestamp fields if present on profile
      if ('bannedUntil' in driverData && driverData.bannedUntil !== null && !isStrictTimestamp(driverData.bannedUntil, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile bannedUntil is invalid Timestamp');
      }
      if ('locationUpdatedAt' in driverData && driverData.locationUpdatedAt !== null && !isStrictTimestamp(driverData.locationUpdatedAt, TimestampClass)) {
        throw new HttpsError('failed-precondition', 'Driver profile locationUpdatedAt is invalid Timestamp');
      }

      // Validate verificationStatus enum: only null/absent, pending, approved, rejected
      // Reject legacy "verified" as MALFORMED state
      const currentStatus = driverData.verificationStatus;
      if (!ALLOWED_VERIFICATION_STATUSES.includes(currentStatus)) {
        throw new HttpsError('failed-precondition', `Driver profile verificationStatus is invalid/malformed: "${currentStatus}"`);
      }

      // Cross-field validation: if pending, approved, or rejected, verificationDocs must be canonical
      if (['pending', 'approved', 'rejected'].includes(currentStatus)) {
        if (!isValidVerificationDocs(driverData.verificationDocs, TimestampClass)) {
          throw new HttpsError('failed-precondition', 'Driver profile verificationDocs is missing or malformed');
        }
      } else if (currentStatus === null || currentStatus === undefined) {
        if ('verificationDocs' in driverData && driverData.verificationDocs !== null && !isValidVerificationDocs(driverData.verificationDocs, TimestampClass)) {
          throw new HttpsError('failed-precondition', 'Driver profile verificationDocs is malformed');
        }
      }

      // RejectionReason validation
      if ('rejectionReason' in driverData && driverData.rejectionReason !== null && typeof driverData.rejectionReason !== 'string') {
        throw new HttpsError('failed-precondition', 'Driver profile rejectionReason must be a string or null');
      }

      // State Transition Decision
      if (currentStatus === 'approved') {
        throw new HttpsError('failed-precondition', 'Driver is already verified and approved');
      }

      // Pending state: check idempotency
      if (currentStatus === 'pending') {
        const expectedIdUrl = `gs://${bucketName}/driver_verification/${driverUid}/id.jpg`;
        const expectedRcUrl = `gs://${bucketName}/driver_verification/${driverUid}/rc.jpg`;
        const expectedSelfieUrl = `gs://${bucketName}/driver_verification/${driverUid}/selfie.jpg`;

        if (
          driverData.verificationDocs.idPhotoUrl === expectedIdUrl &&
          driverData.verificationDocs.rcPhotoUrl === expectedRcUrl &&
          driverData.verificationDocs.selfiePhotoUrl === expectedSelfieUrl
        ) {
          // Idempotent: return success with zero writes (no submittedAt churn)
          return { success: true, status: 'pending' };
        }

        throw new HttpsError('failed-precondition', 'Pending driver verificationDocs do not match canonical storage documents');
      }

      // Unsubmitted (null/absent) or rejected -> transition to pending
      const getServerSentinel = () => (FieldValueClass && typeof FieldValueClass.serverTimestamp === 'function')
        ? FieldValueClass.serverTimestamp()
        : FieldValue.serverTimestamp();

      const newVerificationDocs = {
        idPhotoUrl: `gs://${bucketName}/driver_verification/${driverUid}/id.jpg`,
        rcPhotoUrl: `gs://${bucketName}/driver_verification/${driverUid}/rc.jpg`,
        selfiePhotoUrl: `gs://${bucketName}/driver_verification/${driverUid}/selfie.jpg`,
        submittedAt: getServerSentinel(),
      };

      transaction.update(driverRef, {
        verificationStatus: 'pending',
        verificationDocs: newVerificationDocs,
        rejectionReason: null,
        updatedAt: getServerSentinel(),
      });

      return { success: true, status: 'pending' };
    });
  }

  return {
    submitDriverVerification,
  };
}

let defaultManager;
function getDefaultSubmitDriverVerificationManager() {
  if (!defaultManager) {
    defaultManager = createSubmitDriverVerificationManager();
  }
  return defaultManager;
}

function createSubmitDriverVerificationCallable({ manager } = {}) {
  const handler = async request => {
    const mgr = manager || getDefaultSubmitDriverVerificationManager();
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Driver must be authenticated');
    }
    const driverUid = request.auth.uid;
    return await mgr.submitDriverVerification({ driverUid });
  };

  const fn = onCall({ region: 'asia-south1' }, handler);
  fn.run = handler;
  return fn;
}

const submitDriverVerification = createSubmitDriverVerificationCallable();

module.exports = {
  REQUIRED_DOCS,
  isStrictTimestamp,
  isValidVerificationDocs,
  createSubmitDriverVerificationManager,
  getDefaultSubmitDriverVerificationManager,
  createSubmitDriverVerificationCallable,
  submitDriverVerification,
};
