'use strict';

/**
 * TowMitra Phase 6 M2 — Fresh Admin Authority Verification (M2-ARCH-1, Section 5)
 *
 * Requirements:
 * 1. Require authenticated callable UID and strict boolean request.auth.token.admin === true.
 * 2. Extract invocation Bearer ID token. Use Admin Auth verifyIdToken(token, true) (checkRevoked=true).
 *    Require decoded UID equal to callable UID, strict decoded admin === true.
 *    Reject expired, revoked, or invalid tokens.
 *    Reject fixture bypass 'owner' credential as callable authority.
 * 3. Fresh getAuth().getUser(uid) must exist, disabled === false, and customClaims.admin === true.
 *    No caching between calls.
 * 4. Repeat revoked-token/current-user checks in every automatic transaction attempt,
 *    including completed-receipt replay.
 * 5. Safe HttpsError mapping with standard codes (unauthenticated, permission-denied, unavailable).
 */

const { getAuth } = require('firebase-admin/auth');
const { HttpsError } = require('firebase-functions/v2/https');

const PERMANENT_TOKEN_REJECTION_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/invalid-credential',
  'auth/user-disabled',
  'auth/user-not-found',
]);

function classifyVerifyTokenError(err) {
  if (err instanceof HttpsError) {
    return err;
  }
  const code = typeof err?.code === 'string' ? err.code : '';
  if (PERMANENT_TOKEN_REJECTION_CODES.has(code)) {
    return new HttpsError('unauthenticated', 'ID token is invalid, expired, or revoked');
  }
  return new HttpsError('unavailable', 'Authority service temporarily unavailable. Please retry.');
}

function extractBearerToken(request) {
  if (request && typeof request.token === 'string' && request.token.trim()) {
    return request.token.trim();
  }
  const authHeader = request?.rawRequest?.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return null;
}

async function verifyAdminCaller({ request, auth = null }) {
  if (!request || !request.auth || !request.auth.uid || typeof request.auth.uid !== 'string' || !request.auth.uid.trim()) {
    throw new HttpsError('unauthenticated', 'Admin must be authenticated');
  }

  const callableUid = request.auth.uid;

  if (request.auth.token?.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin custom claim required');
  }

  const token = extractBearerToken(request);
  if (!token) {
    throw new HttpsError('unauthenticated', 'Missing Bearer ID token in request');
  }

  if (token === 'owner') {
    throw new HttpsError('permission-denied', 'Owner bypass credential is not callable authority');
  }

  const adminAuth = auth || getAuth();

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(token, true /* checkRevoked */);
  } catch (err) {
    throw classifyVerifyTokenError(err);
  }

  if (!decoded || decoded.uid !== callableUid) {
    throw new HttpsError('unauthenticated', 'Token UID does not match callable UID');
  }

  if (decoded.admin !== true) {
    throw new HttpsError('permission-denied', 'Token admin claim is not boolean true');
  }

  let userRecord;
  try {
    userRecord = await adminAuth.getUser(callableUid);
  } catch (err) {
    if (err && (err.code === 'auth/user-not-found' || err.code === 404)) {
      throw new HttpsError('unauthenticated', 'Admin user account does not exist');
    }
    throw new HttpsError('unavailable', 'Authority check unavailable');
  }

  if (!userRecord) {
    throw new HttpsError('unauthenticated', 'Admin user account does not exist');
  }

  if (userRecord.disabled === true) {
    throw new HttpsError('permission-denied', 'Admin user account is disabled');
  }

  if (!userRecord.customClaims || userRecord.customClaims.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin privilege revoked');
  }

  return {
    uid: callableUid,
    token,
    userRecord,
  };
}

async function verifyAdminFresh({ uid, token, auth = null }) {
  if (!uid || typeof uid !== 'string' || !token || typeof token !== 'string') {
    throw new HttpsError('unauthenticated', 'Missing admin credentials');
  }

  if (token === 'owner') {
    throw new HttpsError('permission-denied', 'Owner bypass credential is not callable authority');
  }

  const adminAuth = auth || getAuth();

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(token, true /* checkRevoked */);
  } catch (err) {
    throw classifyVerifyTokenError(err);
  }

  if (!decoded || decoded.uid !== uid) {
    throw new HttpsError('unauthenticated', 'Token UID does not match admin UID');
  }

  if (decoded.admin !== true) {
    throw new HttpsError('permission-denied', 'Token admin claim is not boolean true');
  }

  let userRecord;
  try {
    userRecord = await adminAuth.getUser(uid);
  } catch (err) {
    if (err && (err.code === 'auth/user-not-found' || err.code === 404)) {
      throw new HttpsError('unauthenticated', 'Admin user account does not exist');
    }
    throw new HttpsError('unavailable', 'Authority check unavailable');
  }

  if (!userRecord) {
    throw new HttpsError('unauthenticated', 'Admin user account does not exist');
  }

  if (userRecord.disabled === true) {
    throw new HttpsError('permission-denied', 'Admin user account is disabled');
  }

  if (!userRecord.customClaims || userRecord.customClaims.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin privilege revoked');
  }

  return userRecord;
}

module.exports = {
  extractBearerToken,
  verifyAdminCaller,
  verifyAdminFresh,
};
