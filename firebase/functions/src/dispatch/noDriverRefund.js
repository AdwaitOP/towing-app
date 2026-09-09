'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const {
  DispatchError,
  positive,
  isAuthoritativeTimestamp,
  timestampMillis,
  exactKeys,
  OUTBOX_EXACT_KEYS,
  OUTBOX_ALLOWED_STATES,
  OUTBOX_ALLOWED_ERROR_CODES,
  compareTimestamps,
  timestampsEqual,
  timestampLessThanOrEqual,
  timestampLessThan,
} = require('./dispatchValidation');
const { createRazorpayClient, ProviderResponseError } = require('../services/razorpayClient');

const LEASE_DURATION_MS = 60000;
const INITIAL_RECONCILIATION_DELAY_MS = 30000;
const MAX_INITIATION_ATTEMPTS = 5;
const MAX_RECONCILIATION_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 300000;
const RECONCILIATION_BACKOFF_BASE_MS = 30000;
const RECONCILIATION_MAX_BACKOFF_MS = 900000;

const REFUND_REQUEST_KEYS = [
  'operationId', 'jobId', 'razorpayPaymentId', 'amountPaise', 'reason',
  'providerIdempotencyKey', 'providerRequestHash', 'state', 'ownerToken',
  'leaseUntil', 'nextAttemptAt', 'reconciliationNextAttemptAt',
  'reconciliationAttempts', 'razorpayRefundId', 'confirmationSource',
  'attemptCount', 'lastErrorCode', 'createdAt', 'updatedAt', 'submittedAt',
  'confirmedAt',
];

function calculateBackoffMs(attemptCount) {
  const count = Math.max(1, attemptCount);
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, count - 1));
}

function calculateReconciliationBackoffMs(attempts) {
  const count = Math.max(1, attempts);
  return Math.min(RECONCILIATION_MAX_BACKOFF_MS, RECONCILIATION_BACKOFF_BASE_MS * Math.pow(2, count - 1));
}

function classifyProviderError(error) {
  if (error?.code === 'CONFIGURATION_ERROR' || error?.name === 'CONFIGURATION_ERROR' || error?.message?.includes('Missing required configuration')) {
    return { code: 'PROVIDER_AUTHENTICATION_ERROR', retryable: false, category: 'B' };
  }

  if (error?.name === 'AbortError' || error?.message?.toLowerCase().includes('timed out')) {
    return { code: 'PROVIDER_TIMEOUT', retryable: true, category: 'A' };
  }

  const msg = (error?.message || '').toLowerCase();
  const desc = (error?.providerBody?.error?.description || '').toLowerCase();
  const rawStatus = error?.status;

  if (rawStatus === 409) {
    if (desc.includes('different request') || msg.includes('different request') || desc.includes('already been processed')) {
      return { code: 'PROVIDER_IDEMPOTENCY_CONFLICT', retryable: false, category: 'B' };
    }
    return { code: 'PROVIDER_PROCESSING_CONFLICT', retryable: true, category: 'A' };
  }

  if (rawStatus === 429) {
    return { code: 'PROVIDER_RATE_LIMITED', retryable: true, category: 'A' };
  }

  if ([500, 502, 503, 504].includes(rawStatus)) {
    return { code: 'PROVIDER_UNAVAILABLE', retryable: true, category: 'A' };
  }

  if ([401, 403].includes(rawStatus)) {
    return { code: 'PROVIDER_AUTHENTICATION_ERROR', retryable: false, category: 'B' };
  }

  if (rawStatus === 404) {
    return { code: 'PROVIDER_PAYMENT_NOT_FOUND', retryable: false, category: 'B' };
  }

  if (rawStatus === 400) {
    if (desc.includes('another') || desc.includes('in progress') || desc.includes('concurrent')) {
      return { code: 'PROVIDER_CONCURRENT_MUTATION', retryable: true, category: 'A' };
    }
    if (desc.includes('already refunded') || desc.includes('fully refunded')) {
      return { code: 'PROVIDER_ALREADY_REFUNDED_AMBIGUOUS', retryable: true, category: 'C' };
    }
    if (desc.includes('amount') || desc.includes('exceeds')) {
      return { code: 'PROVIDER_AMOUNT_EXCEEDED', retryable: false, category: 'B' };
    }
    return { code: 'PROVIDER_BAD_REQUEST', retryable: false, category: 'B' };
  }

  if (error instanceof ProviderResponseError) {
    return { code: 'PROVIDER_RESPONSE_INVALID', retryable: false, category: 'B' };
  }

  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed')) {
    return { code: 'PROVIDER_NETWORK_ERROR', retryable: true, category: 'A' };
  }

  return { code: 'PROVIDER_UNAVAILABLE', retryable: true, category: 'A' };
}

function safeCompareTimestamps(a, b, TimestampClass) {
  try {
    return compareTimestamps(a, b, TimestampClass);
  } catch {
    if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return null;
    if (a instanceof Date || b instanceof Date) return null;
    if (typeof a.toMillis === 'function' && typeof b.toMillis === 'function') {
      const aMs = a.toMillis();
      const bMs = b.toMillis();
      if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
        if (aMs < bMs) return -1;
        if (aMs > bMs) return 1;
        return 0;
      }
    }
    return null;
  }
}

function safeTimestampsEqual(a, b, TimestampClass) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return timestampsEqual(a, b, TimestampClass);
  } catch {
    const cmp = safeCompareTimestamps(a, b, TimestampClass);
    return cmp === 0;
  }
}

function safeTimestampLessThanOrEqual(a, b, TimestampClass) {
  try {
    return timestampLessThanOrEqual(a, b, TimestampClass);
  } catch {
    const cmp = safeCompareTimestamps(a, b, TimestampClass);
    return cmp !== null && cmp <= 0;
  }
}

function timestampsInOrder(early, late, TimestampClass) {
  return safeTimestampLessThanOrEqual(early, late, TimestampClass);
}

function validateRefundConfirmedOutbox(outbox, { jobId, amountPaise, TimestampClass } = {}) {
  if (!outbox || typeof outbox !== 'object' || Array.isArray(outbox)) return false;
  if (!exactKeys(outbox, OUTBOX_EXACT_KEYS)) return false;
  if (outbox.eventId !== 'refund_confirmed:' + jobId) return false;
  if (outbox.eventType !== 'refund_confirmed') return false;
  if (outbox.resourceType !== 'refund_request') return false;
  if (outbox.resourceId !== jobId) return false;
  if (outbox.channel !== 'whatsapp') return false;
  if (outbox.recipientKey !== 'customer:' + jobId) return false;
  if (outbox.payloadVersion !== 1) return false;

  if (!outbox.payload || typeof outbox.payload !== 'object' || Array.isArray(outbox.payload)) return false;
  if (!exactKeys(outbox.payload, ['jobId', 'jobStatus', 'refundAmountPaise'])) return false;
  if (outbox.payload.jobId !== jobId) return false;
  if (outbox.payload.jobStatus !== 'cancelled_system') return false;
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return false;
  if (outbox.payload.refundAmountPaise !== amountPaise) return false;

  if (!OUTBOX_ALLOWED_STATES.includes(outbox.state)) return false;
  if (!Number.isSafeInteger(outbox.attemptCount) || outbox.attemptCount < 0) return false;
  if (!isAuthoritativeTimestamp(outbox.createdAt, TimestampClass)) return false;
  if (!isAuthoritativeTimestamp(outbox.updatedAt, TimestampClass)) return false;
  if (!timestampsInOrder(outbox.createdAt, outbox.updatedAt, TimestampClass)) return false;

  if (outbox.lastErrorCode !== null && !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)) return false;
  if (outbox.providerMessageId !== null && (typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0)) return false;
  if (outbox.leaseUntil !== null && !isAuthoritativeTimestamp(outbox.leaseUntil, TimestampClass)) return false;
  if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) return false;
  if (outbox.ownerToken !== null && (typeof outbox.ownerToken !== 'string' || outbox.ownerToken.length === 0)) return false;
  if (outbox.sentAt !== null && !isAuthoritativeTimestamp(outbox.sentAt, TimestampClass)) return false;

  if (outbox.state === 'pending') {
    if (outbox.attemptCount !== 0 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
        outbox.providerMessageId !== null ||
        outbox.lastErrorCode !== null ||
        outbox.sentAt !== null) {
      return false;
    }
  } else if (outbox.state === 'in_progress') {
    if (outbox.attemptCount < 1 ||
        typeof outbox.ownerToken !== 'string' || outbox.ownerToken.length === 0 ||
        !isAuthoritativeTimestamp(outbox.leaseUntil, TimestampClass) ||
        outbox.providerMessageId !== null ||
        outbox.sentAt !== null) {
      return false;
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      return false;
    }
    if (outbox.lastErrorCode !== null && !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode)) {
      return false;
    }
  } else if (outbox.state === 'retry_wait') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass) ||
        !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode) ||
        outbox.providerMessageId !== null ||
        outbox.sentAt !== null) {
      return false;
    }
  } else if (outbox.state === 'sent') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !isAuthoritativeTimestamp(outbox.sentAt, TimestampClass) ||
        typeof outbox.providerMessageId !== 'string' || outbox.providerMessageId.length === 0 ||
        outbox.lastErrorCode !== null) {
      return false;
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      return false;
    }
    if (!timestampsInOrder(outbox.createdAt, outbox.sentAt, TimestampClass)) return false;
    if (!timestampsInOrder(outbox.sentAt, outbox.updatedAt, TimestampClass)) return false;
  } else if (outbox.state === 'failed_terminal') {
    if (outbox.attemptCount < 1 ||
        outbox.ownerToken !== null ||
        outbox.leaseUntil !== null ||
        !OUTBOX_ALLOWED_ERROR_CODES.includes(outbox.lastErrorCode) ||
        outbox.providerMessageId !== null ||
        outbox.sentAt !== null) {
      return false;
    }
    if (outbox.nextAttemptAt !== null && !isAuthoritativeTimestamp(outbox.nextAttemptAt, TimestampClass)) {
      return false;
    }
  }

  return true;
}

const REFUND_ALLOWED_STATES = [
  'pending', 'in_progress', 'submitted', 'confirmed', 'retry_wait', 'failed_terminal',
];

const STAGE9_ALLOWED_ERROR_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_IDEMPOTENCY_CONFLICT',
  'PROVIDER_PROCESSING_CONFLICT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTHENTICATION_ERROR',
  'PROVIDER_PAYMENT_NOT_FOUND',
  'PROVIDER_CONCURRENT_MUTATION',
  'PROVIDER_ALREADY_REFUNDED_AMBIGUOUS',
  'PROVIDER_AMOUNT_EXCEEDED',
  'PROVIDER_BAD_REQUEST',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_REFUND_FAILED',
  'PROVIDER_NETWORK_ERROR',
  'MAX_ATTEMPTS_EXCEEDED',
]);

const VALID_REFUND_ID_REGEX = /^rfnd_[A-Za-z0-9]+$/;
function isValidRefundId(id) {
  return typeof id === 'string' && VALID_REFUND_ID_REGEX.test(id) && id.length >= 10;
}

function validateRefundRequestLifecycle(refund, { jobId, bookingFeePaise, razorpayPaymentId, TimestampClass, nowMs = null, allowBoundInProgress = false } = {}) {
  if (!refund || typeof refund !== 'object' || Array.isArray(refund)) return false;
  if (!exactKeys(refund, REFUND_REQUEST_KEYS)) return false;

  // Exact identities
  if (refund.operationId !== jobId || refund.jobId !== jobId) return false;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) return false;
  if (refund.reason !== 'no_driver_found') return false;
  if (refund.amountPaise !== bookingFeePaise) return false;
  if (!Number.isSafeInteger(refund.amountPaise) || refund.amountPaise <= 0) return false;
  if (refund.razorpayPaymentId !== razorpayPaymentId) return false;
  if (typeof refund.razorpayPaymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(refund.razorpayPaymentId)) return false;

  const expectedKey = 'refund_no_driver_found_' + jobId;
  if (refund.providerIdempotencyKey !== expectedKey) return false;

  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId: razorpayPaymentId,
    amount: bookingFeePaise,
  }), 'utf8').digest('hex');
  if (refund.providerRequestHash !== expectedHash) return false;

  // Allowed state
  if (!REFUND_ALLOWED_STATES.includes(refund.state)) return false;

  // Counters
  if (!Number.isSafeInteger(refund.attemptCount) || refund.attemptCount < 0) return false;
  if (!Number.isSafeInteger(refund.reconciliationAttempts) || refund.reconciliationAttempts < 0) return false;

  // Timestamps
  if (!isAuthoritativeTimestamp(refund.createdAt, TimestampClass)) return false;
  if (!isAuthoritativeTimestamp(refund.updatedAt, TimestampClass)) return false;
  if (!timestampsInOrder(refund.createdAt, refund.updatedAt, TimestampClass)) return false;

  const nowTs = nowMs !== null ? TimestampClass.fromMillis(nowMs) : null;
  if (nowTs) {
    if (!timestampsInOrder(refund.createdAt, nowTs, TimestampClass)) return false;
    if (!timestampsInOrder(refund.updatedAt, nowTs, TimestampClass)) return false;
  }

  if (refund.submittedAt !== null) {
    if (!isAuthoritativeTimestamp(refund.submittedAt, TimestampClass)) return false;
    if (!timestampsInOrder(refund.createdAt, refund.submittedAt, TimestampClass)) return false;
    if (nowTs && !timestampsInOrder(refund.submittedAt, nowTs, TimestampClass)) return false;
  }

  if (refund.confirmedAt !== null) {
    if (!isAuthoritativeTimestamp(refund.confirmedAt, TimestampClass)) return false;
    if (!timestampsInOrder(refund.createdAt, refund.confirmedAt, TimestampClass)) return false;
    if (refund.submittedAt !== null && !timestampsInOrder(refund.submittedAt, refund.confirmedAt, TimestampClass)) return false;
    if (nowTs && !timestampsInOrder(refund.confirmedAt, nowTs, TimestampClass)) return false;
  }

  if (refund.nextAttemptAt !== null && !isAuthoritativeTimestamp(refund.nextAttemptAt, TimestampClass)) return false;
  if (refund.reconciliationNextAttemptAt !== null && !isAuthoritativeTimestamp(refund.reconciliationNextAttemptAt, TimestampClass)) return false;
  if (refund.leaseUntil !== null && !isAuthoritativeTimestamp(refund.leaseUntil, TimestampClass)) return false;

  // Bounded codes & values
  if (refund.ownerToken !== null && (typeof refund.ownerToken !== 'string' || refund.ownerToken.length === 0)) return false;
  if (refund.lastErrorCode !== null) {
    if (typeof refund.lastErrorCode !== 'string' || !STAGE9_ALLOWED_ERROR_CODES.has(refund.lastErrorCode)) return false;
  }
  if (refund.confirmationSource !== null && !['webhook', 'reconciliation'].includes(refund.confirmationSource)) return false;
  if (refund.razorpayRefundId !== null && !isValidRefundId(refund.razorpayRefundId)) return false;

  // State-specific invariants
  if (refund.state === 'pending') {
    if (
      refund.attemptCount !== 0 ||
      refund.reconciliationAttempts !== 0 ||
      refund.ownerToken !== null ||
      refund.leaseUntil !== null ||
      !isAuthoritativeTimestamp(refund.nextAttemptAt, TimestampClass) ||
      refund.reconciliationNextAttemptAt !== null ||
      refund.razorpayRefundId !== null ||
      refund.confirmationSource !== null ||
      refund.lastErrorCode !== null ||
      refund.submittedAt !== null ||
      refund.confirmedAt !== null
    ) {
      return false;
    }
  } else if (refund.state === 'retry_wait') {
    if (
      refund.attemptCount < 1 ||
      refund.attemptCount > MAX_INITIATION_ATTEMPTS ||
      refund.reconciliationAttempts !== 0 ||
      refund.ownerToken !== null ||
      refund.leaseUntil !== null ||
      !isAuthoritativeTimestamp(refund.nextAttemptAt, TimestampClass) ||
      refund.reconciliationNextAttemptAt !== null ||
      refund.razorpayRefundId !== null ||
      refund.confirmationSource !== null ||
      refund.lastErrorCode === null ||
      refund.submittedAt !== null ||
      refund.confirmedAt !== null
    ) {
      return false;
    }
  } else if (refund.state === 'in_progress') {
    if (
      refund.attemptCount < 1 ||
      typeof refund.ownerToken !== 'string' ||
      refund.ownerToken.length === 0 ||
      !isAuthoritativeTimestamp(refund.leaseUntil, TimestampClass) ||
      !isAuthoritativeTimestamp(refund.nextAttemptAt, TimestampClass) ||
      refund.reconciliationNextAttemptAt !== null ||
      refund.reconciliationAttempts !== 0 ||
      (!allowBoundInProgress && refund.razorpayRefundId !== null) ||
      refund.confirmationSource !== null ||
      refund.submittedAt !== null ||
      refund.confirmedAt !== null
    ) {
      return false;
    }
  } else if (refund.state === 'submitted') {
    const hasOwner = typeof refund.ownerToken === 'string' && refund.ownerToken.length > 0;
    const hasLease = isAuthoritativeTimestamp(refund.leaseUntil, TimestampClass);
    if (hasOwner !== hasLease) return false;
    if (!hasOwner && refund.ownerToken !== null) return false;
    if (!hasLease && refund.leaseUntil !== null) return false;

    if (
      refund.attemptCount < 1 ||
      !isValidRefundId(refund.razorpayRefundId) ||
      !isAuthoritativeTimestamp(refund.submittedAt, TimestampClass) ||
      !isAuthoritativeTimestamp(refund.reconciliationNextAttemptAt, TimestampClass) ||
      refund.nextAttemptAt !== null ||
      refund.confirmationSource !== null ||
      refund.confirmedAt !== null
    ) {
      return false;
    }
  } else if (refund.state === 'confirmed') {
    if (
      refund.attemptCount < 1 ||
      !isValidRefundId(refund.razorpayRefundId) ||
      !isAuthoritativeTimestamp(refund.confirmedAt, TimestampClass) ||
      !['webhook', 'reconciliation'].includes(refund.confirmationSource) ||
      refund.ownerToken !== null ||
      refund.leaseUntil !== null ||
      refund.reconciliationNextAttemptAt !== null ||
      refund.nextAttemptAt !== null ||
      refund.lastErrorCode !== null
    ) {
      return false;
    }
  } else if (refund.state === 'failed_terminal') {
    if (
      refund.attemptCount < 1 ||
      refund.lastErrorCode === null ||
      typeof refund.lastErrorCode !== 'string' ||
      !STAGE9_ALLOWED_ERROR_CODES.has(refund.lastErrorCode) ||
      refund.ownerToken !== null ||
      refund.leaseUntil !== null ||
      refund.nextAttemptAt !== null ||
      refund.reconciliationNextAttemptAt !== null ||
      refund.confirmationSource !== null ||
      refund.confirmedAt !== null
    ) {
      return false;
    }
  }

  return true;
}

function validateRefundRequestRecord(refund, options = {}) {
  return validateRefundRequestLifecycle(refund, options);
}

function validateJobRefundProjection(job, refund, { TimestampClass, nowMs = null, allowSubmittedJobConfirmedAt = false } = {}) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return false;

  // Provenance & immutable financial identity
  if (
    job.status !== 'cancelled_system' ||
    job.dispatchState !== 'closed' ||
    job.cancelledBy !== 'system' ||
    job.cancellationReason !== 'no_driver_found'
  ) {
    return false;
  }
  if (job.refundRequestId !== refund.jobId) return false;
  if (job.bookingFeePaise !== refund.amountPaise) return false;
  if (job.razorpayPaymentId !== refund.razorpayPaymentId) return false;
  if (!isAuthoritativeTimestamp(job.paymentConfirmedAt, TimestampClass)) return false;
  if (!timestampsInOrder(job.paymentConfirmedAt, refund.createdAt, TimestampClass)) return false;

  if (nowMs !== null) {
    const nowTs = TimestampClass.fromMillis(nowMs);
    if (!timestampsInOrder(job.paymentConfirmedAt, nowTs, TimestampClass)) return false;
  }

  // Exact state match
  if (job.refundState !== refund.state) return false;

  // Exact schedule projection (NO "both due" exception!)
  if (refund.state === 'pending' || refund.state === 'retry_wait' || refund.state === 'in_progress') {
    if (!isAuthoritativeTimestamp(job.refundNextAttemptAt, TimestampClass)) return false;
    if (!safeTimestampsEqual(job.refundNextAttemptAt, refund.nextAttemptAt, TimestampClass)) return false;
  } else if (refund.state === 'submitted') {
    if (!isAuthoritativeTimestamp(job.refundNextAttemptAt, TimestampClass)) return false;
    if (!safeTimestampsEqual(job.refundNextAttemptAt, refund.reconciliationNextAttemptAt, TimestampClass)) return false;
  } else if (refund.state === 'confirmed' || refund.state === 'failed_terminal') {
    if (job.refundNextAttemptAt !== null && job.refundNextAttemptAt !== undefined) return false;
  }

  // Provider refund ID projection
  if (refund.state === 'submitted' || refund.state === 'confirmed') {
    if (job.razorpayRefundId !== refund.razorpayRefundId) return false;
  } else if (refund.state === 'pending' || refund.state === 'retry_wait') {
    if (job.razorpayRefundId !== null && job.razorpayRefundId !== undefined) return false;
  } else if (refund.state === 'in_progress' || refund.state === 'failed_terminal') {
    if (refund.razorpayRefundId === null) {
      if (job.razorpayRefundId !== null && job.razorpayRefundId !== undefined) return false;
    } else {
      if (job.razorpayRefundId !== refund.razorpayRefundId) return false;
    }
  }

  // Confirmation markers
  if (refund.state === 'confirmed') {
    if (!isAuthoritativeTimestamp(job.refundConfirmedAt, TimestampClass)) return false;
    if (!safeTimestampsEqual(job.refundConfirmedAt, refund.confirmedAt, TimestampClass)) return false;
    if (job.refundedAmountPaise !== refund.amountPaise) return false;
  } else if (refund.state === 'submitted' && allowSubmittedJobConfirmedAt) {
    if (job.refundConfirmedAt !== null && job.refundConfirmedAt !== undefined) {
      if (!isAuthoritativeTimestamp(job.refundConfirmedAt, TimestampClass)) return false;
    }
    if (job.refundedAmountPaise !== null && job.refundedAmountPaise !== undefined) {
      if (job.refundedAmountPaise !== refund.amountPaise) return false;
    }
  } else {
    if (job.refundConfirmedAt !== null && job.refundConfirmedAt !== undefined) return false;
    if (job.refundedAmountPaise !== null && job.refundedAmountPaise !== undefined) return false;
  }

  return true;
}

function assertCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs = null) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new DispatchError('JOB_NOT_FOUND');
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new DispatchError('INVALID_ARGUMENT');
  }
  if (
    job.status !== 'cancelled_system' ||
    job.dispatchState !== 'closed' ||
    job.cancelledBy !== 'system' ||
    job.cancellationReason !== 'no_driver_found'
  ) {
    throw new DispatchError('JOB_NOT_SYSTEM_CANCELLED');
  }
  if (job.refundRequestId !== jobId) {
    throw new DispatchError('REFUND_REQUEST_ID_MISMATCH');
  }
  if (typeof job.razorpayPaymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(job.razorpayPaymentId)) {
    throw new DispatchError('PAYMENT_ID_INVALID');
  }
  if (!isAuthoritativeTimestamp(job.paymentConfirmedAt, TimestampClass)) {
    throw new DispatchError('PAYMENT_NOT_CONFIRMED');
  }
  if (!Number.isSafeInteger(job.bookingFeePaise) || job.bookingFeePaise <= 0) {
    throw new DispatchError('REFUND_AMOUNT_INVALID');
  }

  if (!refund || typeof refund !== 'object' || Array.isArray(refund)) throw new DispatchError('DOCUMENT_NOT_FOUND');

  if (!exactKeys(refund, REFUND_REQUEST_KEYS)) {
    throw new DispatchError('REFUND_SCHEMA_INVALID');
  }

  if (refund.amountPaise !== job.bookingFeePaise) {
    throw new DispatchError('REFUND_AMOUNT_MISMATCH');
  }
  if (refund.razorpayPaymentId !== job.razorpayPaymentId) {
    throw new DispatchError('PAYMENT_ID_MISMATCH');
  }
  const expectedKey = 'refund_no_driver_found_' + jobId;
  if (refund.providerIdempotencyKey !== expectedKey) {
    throw new DispatchError('IDEMPOTENCY_KEY_MISMATCH');
  }
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify({
    paymentId: job.razorpayPaymentId,
    amount: job.bookingFeePaise,
  }), 'utf8').digest('hex');
  if (refund.providerRequestHash !== expectedHash) {
    throw new DispatchError('REQUEST_HASH_MISMATCH');
  }

  if (!validateRefundRequestLifecycle(refund, {
    jobId,
    bookingFeePaise: job.bookingFeePaise,
    razorpayPaymentId: job.razorpayPaymentId,
    TimestampClass,
    nowMs,
  })) {
    throw new DispatchError('REFUND_SCHEMA_INVALID');
  }

  if (!validateJobRefundProjection(job, refund, { TimestampClass, nowMs })) {
    throw new DispatchError('JOB_REFUND_STATE_CONTRADICTION');
  }

  return true;
}

function validateCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs = null) {
  try {
    return assertCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs);
  } catch {
    return false;
  }
}

function validateConfirmedOccurrence(job, refund, claim, TimestampClass, nowMs = null) {
  if (!claim || typeof claim !== 'object') return false;
  const jobId = claim.jobId;
  const amount = claim.amount;
  const paymentId = claim.paymentId;

  if (!validateRefundRequestLifecycle(refund, {
    jobId,
    bookingFeePaise: amount,
    razorpayPaymentId: paymentId,
    TimestampClass,
    nowMs,
  })) {
    return false;
  }

  if (refund.state !== 'confirmed') return false;
  if (claim.refundId && refund.razorpayRefundId !== claim.refundId) return false;
  if (claim.expectedRefundId && refund.razorpayRefundId !== claim.expectedRefundId) return false;
  if (claim.reconciliationAttempts !== undefined) {
    if (!Number.isSafeInteger(refund.reconciliationAttempts) || refund.reconciliationAttempts < claim.reconciliationAttempts) {
      return false;
    }
  }

  if (!validateJobRefundProjection(job, refund, { TimestampClass, nowMs })) return false;

  return true;
}

function validateConfirmedWinner(job, refund, claim, TimestampClass, nowMs = null) {
  return validateConfirmedOccurrence(job, refund, claim, TimestampClass, nowMs);
}

function shouldProcessRefundIntent(event) {
  const after = event?.data?.after;
  if (!after || !after.exists) return false;
  const afterData = after.data();
  if (!afterData || afterData.state !== 'pending') return false;
  const before = event?.data?.before;
  if (!before || !before.exists) return true;
  const beforeData = before.data();
  if (beforeData?.state === 'pending') return false;
  return true;
}

function createNoDriverRefundManager({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  razorpayClient = null,
} = {}) {
  const client = razorpayClient || createRazorpayClient();

  function currentMillis() {
    if (now instanceof Date) return now.getTime();
    if (typeof now === 'number') return now;
    if (typeof now === 'function') {
      const val = now();
      if (val instanceof Date) return val.getTime();
      if (typeof val === 'number') return val;
    }
    return Date.now();
  }

  function validateEligibility(job, refund, jobId, nowMs = null) {
    return validateCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs);
  }

  async function processRefundIntent(jobId) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
      return { claimed: false, status: 'rejected', reason: 'INVALID_JOB_ID' };
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const refundRef = db.collection('refund_requests').doc(jobId);

    try {
      if (typeof client.assertConfigured === 'function') {
        client.assertConfigured();
      }
    } catch {
      return {
        claimed: false,
        status: 'rejected',
        reason: 'CONFIGURATION_ERROR',
        errorCode: 'PROVIDER_AUTHENTICATION_ERROR',
        lastErrorCode: 'PROVIDER_AUTHENTICATION_ERROR',
      };
    }

    // ── Transaction 1: Claim for Initiation ─────────────────────────────────
    const claim = await db.runTransaction(async tx => {
      const [jobSnap, refundSnap] = await Promise.all([tx.get(jobRef), tx.get(refundRef)]);
      if (!jobSnap.exists || !refundSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const job = jobSnap.data();
      const refund = refundSnap.data();

      const nowMs = currentMillis();
      assertCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs);

      if (['confirmed', 'submitted', 'failed_terminal'].includes(refund.state)) {
        return { claimed: false, status: refund.state };
      }

      // Check active lease
      if (refund.state === 'in_progress') {
        const leaseUntilMs = timestampMillis(refund.leaseUntil);
        if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
          return { claimed: false, status: refund.state, reason: 'active_lease' };
        }
      }

      // Check due time
      if (refund.state !== 'in_progress' && refund.nextAttemptAt) {
        const nextAttemptMs = timestampMillis(refund.nextAttemptAt);
        if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) {
          return { claimed: false, status: refund.state, reason: 'not_due' };
        }
      }

      // Check attempt limit
      if (refund.attemptCount >= MAX_INITIATION_ATTEMPTS) {
        const at = TimestampClass.fromMillis(nowMs);
        tx.update(refundRef, {
          state: 'failed_terminal',
          lastErrorCode: 'MAX_ATTEMPTS_EXCEEDED',
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: null,
          reconciliationNextAttemptAt: null,
          updatedAt: at,
        });
        tx.update(jobRef, {
          refundState: 'failed_terminal',
          refundNextAttemptAt: null,
          updatedAt: at,
        });
        return { claimed: false, status: 'failed_terminal', reason: 'max_attempts_exceeded' };
      }

      const ownerToken = crypto.randomUUID();
      const at = TimestampClass.fromMillis(nowMs);
      const leaseUntil = TimestampClass.fromMillis(nowMs + LEASE_DURATION_MS);
      const nextAttemptCount = refund.attemptCount + 1;

      tx.update(refundRef, {
        state: 'in_progress',
        ownerToken,
        leaseUntil,
        attemptCount: nextAttemptCount,
        updatedAt: at,
      });

      tx.update(jobRef, {
        refundState: 'in_progress',
        updatedAt: at,
      });

      return {
        claimed: true,
        jobId,
        state: refund.state,
        ownerToken,
        leaseUntil,
        attemptCount: nextAttemptCount,
        paymentId: refund.razorpayPaymentId,
        amount: refund.amountPaise,
        reason: refund.reason,
        idempotencyKey: refund.providerIdempotencyKey,
        requestHash: refund.providerRequestHash,
        expectedRefundId: null,
        createdAt: refund.createdAt,
        updatedAt: at,
        nextAttemptAt: refund.nextAttemptAt,
      };
    });

    if (!claim.claimed) {
      return claim;
    }

    // ── External Provider Call (Outside Transaction) ─────────────────────────
    let response = null;
    let providerError = null;

    try {
      response = await client.createRefund({
        paymentId: claim.paymentId,
        amount: claim.amount,
        idempotencyKey: claim.idempotencyKey,
      });
    } catch (err) {
      providerError = err;
    }

    // ── Revalidation & Finalize Transaction ──────────────────────────────────
    return db.runTransaction(async tx => {
      const outboxId = 'refund_confirmed:' + claim.jobId;
      const outboxRef = db.collection('notification_outbox').doc(outboxId);
      const [jobSnap, refundSnap, outboxSnap] = await Promise.all([
        tx.get(jobRef),
        tx.get(refundRef),
        tx.get(outboxRef),
      ]);
      if (!jobSnap.exists || !refundSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const job = jobSnap.data();
      const refund = refundSnap.data();
      const nowMs = currentMillis();

      // If concurrent webhook already confirmed, validate confirmed winner
      if (refund.state === 'confirmed') {
        if (!validateConfirmedOccurrence(job, refund, claim, TimestampClass, nowMs)) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        if (!outboxSnap.exists || !validateRefundConfirmedOutbox(outboxSnap.data(), { jobId: claim.jobId, amountPaise: claim.amount, TimestampClass })) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        if (response && response.id && refund.razorpayRefundId !== response.id) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        return { status: 'confirmed', finalized: true };
      }

      // Assert lease ownership
      if (refund.ownerToken !== claim.ownerToken || refund.state !== 'in_progress') {
        return { status: refund.state, finalized: false, reason: 'lease_lost' };
      }

      // Revalidate in-flight mutation against claim evidence
      if (
        !safeTimestampsEqual(refund.leaseUntil, claim.leaseUntil, TimestampClass) ||
        refund.attemptCount !== claim.attemptCount ||
        refund.submittedAt !== null ||
        refund.confirmedAt !== null ||
        refund.confirmationSource !== null ||
        refund.razorpayRefundId !== null ||
        !safeTimestampsEqual(refund.createdAt, claim.createdAt, TimestampClass) ||
        !safeTimestampsEqual(refund.updatedAt, claim.updatedAt, TimestampClass) ||
        !safeTimestampsEqual(refund.nextAttemptAt, claim.nextAttemptAt, TimestampClass) ||
        job.bookingFeePaise !== claim.amount ||
        job.razorpayPaymentId !== claim.paymentId ||
        job.status !== 'cancelled_system' ||
        job.cancellationReason !== 'no_driver_found' ||
        job.refundRequestId !== claim.jobId ||
        job.dispatchState !== 'closed' ||
        job.cancelledBy !== 'system' ||
        job.refundState !== 'in_progress' ||
        (job.razorpayRefundId !== null && job.razorpayRefundId !== undefined) ||
        !safeTimestampsEqual(job.refundNextAttemptAt, refund.nextAttemptAt, TimestampClass) ||
        (job.refundedAmountPaise !== null && job.refundedAmountPaise !== undefined) ||
        (job.refundConfirmedAt !== null && job.refundConfirmedAt !== undefined) ||
        !validateRefundRequestLifecycle(refund, {
          jobId: claim.jobId,
          bookingFeePaise: claim.amount,
          razorpayPaymentId: claim.paymentId,
          TimestampClass,
          nowMs,
        }) ||
        !validateJobRefundProjection(job, refund, { TimestampClass, nowMs })
      ) {
        throw new DispatchError('IN_FLIGHT_MUTATION_DETECTED');
      }

      const at = TimestampClass.fromMillis(nowMs);

      if (response) {
        if (response.status === 'failed') {
          // Tx 2C: Synchronous provider rejection
          tx.update(refundRef, {
            state: 'failed_terminal',
            razorpayRefundId: response.id,
            lastErrorCode: 'PROVIDER_REFUND_FAILED',
            ownerToken: null,
            leaseUntil: null,
            nextAttemptAt: null,
            reconciliationNextAttemptAt: null,
            updatedAt: at,
          });
          tx.update(jobRef, {
            refundState: 'failed_terminal',
            razorpayRefundId: response.id,
            refundNextAttemptAt: null,
            updatedAt: at,
          });
          return { status: 'failed_terminal', finalized: true, refundId: response.id };
        }

        // Tx 2A: Valid response (pending or processed moves to submitted)
        const reconciliationDue = TimestampClass.fromMillis(nowMs + INITIAL_RECONCILIATION_DELAY_MS);
        tx.update(refundRef, {
          state: 'submitted',
          razorpayRefundId: response.id,
          submittedAt: at,
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: null,
          reconciliationNextAttemptAt: reconciliationDue,
          reconciliationAttempts: 0,
          lastErrorCode: null,
          updatedAt: at,
        });
        tx.update(jobRef, {
          refundState: 'submitted',
          razorpayRefundId: response.id,
          refundNextAttemptAt: reconciliationDue,
          updatedAt: at,
        });
        return { status: 'submitted', finalized: true, refundId: response.id };
      }

      // Failure Handling
      const classified = classifyProviderError(providerError);

      if (classified.category === 'B' || claim.attemptCount >= MAX_INITIATION_ATTEMPTS) {
        // Tx 2C: Permanent failure or maximum attempts reached
        tx.update(refundRef, {
          state: 'failed_terminal',
          lastErrorCode: classified.code,
          ownerToken: null,
          leaseUntil: null,
          nextAttemptAt: null,
          reconciliationNextAttemptAt: null,
          updatedAt: at,
        });
        tx.update(jobRef, {
          refundState: 'failed_terminal',
          refundNextAttemptAt: null,
          updatedAt: at,
        });
        return { status: 'failed_terminal', finalized: true, errorCode: classified.code };
      }

      // Tx 2B: Transient error / retry wait
      const backoffMs = calculateBackoffMs(claim.attemptCount);
      const nextDue = TimestampClass.fromMillis(nowMs + backoffMs);

      tx.update(refundRef, {
        state: 'retry_wait',
        lastErrorCode: classified.code,
        ownerToken: null,
        leaseUntil: null,
        nextAttemptAt: nextDue,
        updatedAt: at,
      });
      tx.update(jobRef, {
        refundState: 'retry_wait',
        refundNextAttemptAt: nextDue,
        updatedAt: at,
      });
      return { status: 'retry_wait', finalized: true, errorCode: classified.code, nextAttemptAt: nextDue };
    });
  }

  async function reconcileSubmittedRefund(jobId) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(jobId)) {
      return { claimed: false, status: 'rejected', reason: 'INVALID_JOB_ID' };
    }

    try {
      if (typeof client.assertConfigured === 'function') {
        client.assertConfigured();
      }
    } catch {
      return {
        claimed: false,
        status: 'rejected',
        reason: 'CONFIGURATION_ERROR',
        lastErrorCode: 'PROVIDER_AUTHENTICATION_ERROR',
      };
    }

    const jobRef = db.collection('jobs').doc(jobId);
    const refundRef = db.collection('refund_requests').doc(jobId);

    // ── Reconciler Claim Transaction ─────────────────────────────────────────
    const claim = await db.runTransaction(async tx => {
      const [jobSnap, refundSnap] = await Promise.all([tx.get(jobRef), tx.get(refundRef)]);
      if (!jobSnap.exists || !refundSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const job = jobSnap.data();
      const refund = refundSnap.data();

      const nowMs = currentMillis();
      assertCanonicalRefundOccurrence(job, refund, jobId, TimestampClass, nowMs);

      if (refund.state !== 'submitted') {
        return { claimed: false, status: refund.state };
      }

      const hasOwner = typeof refund.ownerToken === 'string' && refund.ownerToken.length > 0;
      const hasLease = isAuthoritativeTimestamp(refund.leaseUntil, TimestampClass);
      if (hasOwner !== hasLease) throw new DispatchError('PRE_GET_STATE_INVALID');
      if (!hasOwner && refund.ownerToken !== null) throw new DispatchError('PRE_GET_STATE_INVALID');
      if (!hasLease && refund.leaseUntil !== null) throw new DispatchError('PRE_GET_STATE_INVALID');

      if (
        refund.attemptCount < 1 ||
        !isValidRefundId(refund.razorpayRefundId) ||
        !isAuthoritativeTimestamp(refund.submittedAt, TimestampClass) ||
        !isAuthoritativeTimestamp(refund.reconciliationNextAttemptAt, TimestampClass) ||
        refund.nextAttemptAt !== null ||
        refund.confirmedAt !== null ||
        refund.confirmationSource !== null ||
        !Number.isSafeInteger(refund.reconciliationAttempts) ||
        refund.reconciliationAttempts < 0
      ) {
        throw new DispatchError('PRE_GET_STATE_INVALID');
      }

      const nowTs = TimestampClass.fromMillis(nowMs);
      if (
        !timestampsInOrder(refund.submittedAt, nowTs, TimestampClass) ||
        !timestampsInOrder(refund.createdAt, nowTs, TimestampClass) ||
        !timestampsInOrder(refund.updatedAt, nowTs, TimestampClass)
      ) {
        throw new DispatchError('PRE_GET_STATE_INVALID');
      }

      if (!safeTimestampsEqual(refund.reconciliationNextAttemptAt, job.refundNextAttemptAt, TimestampClass)) {
        throw new DispatchError('PRE_GET_STATE_INVALID');
      }

      if (refund.reconciliationNextAttemptAt) {
        const nextAttemptMs = timestampMillis(refund.reconciliationNextAttemptAt);
        if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) {
          return { claimed: false, status: refund.state, reason: 'not_due' };
        }
      }

      if (hasOwner && hasLease) {
        const leaseUntilMs = timestampMillis(refund.leaseUntil);
        if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
          return { claimed: false, status: refund.state, reason: 'active_lease' };
        }
      }

      const ownerToken = crypto.randomUUID();
      const at = TimestampClass.fromMillis(nowMs);
      const leaseUntil = TimestampClass.fromMillis(nowMs + LEASE_DURATION_MS);

      tx.update(refundRef, {
        ownerToken,
        leaseUntil,
        updatedAt: at,
      });

      return {
        claimed: true,
        jobId,
        ownerToken,
        leaseUntil,
        paymentId: refund.razorpayPaymentId,
        refundId: refund.razorpayRefundId,
        amount: refund.amountPaise,
        reason: refund.reason,
        idempotencyKey: refund.providerIdempotencyKey,
        requestHash: refund.providerRequestHash,
        attemptCount: refund.attemptCount,
        reconciliationAttempts: refund.reconciliationAttempts,
        submittedAt: refund.submittedAt,
        reconciliationNextAttemptAt: refund.reconciliationNextAttemptAt,
        createdAt: refund.createdAt,
        updatedAt: at,
      };
    });

    if (!claim.claimed) {
      return claim;
    }

    // ── External Provider Status Fetch (Outside Transaction) ─────────────────
    let response = null;
    let fetchError = null;

    try {
      response = await client.getRefund({
        paymentId: claim.paymentId,
        refundId: claim.refundId,
        amount: claim.amount,
      });
    } catch (err) {
      fetchError = err;
    }

    // ── Reconciler Finalize Transaction ──────────────────────────────────────
    return db.runTransaction(async tx => {
      const outboxId = 'refund_confirmed:' + claim.jobId;
      const outboxRef = db.collection('notification_outbox').doc(outboxId);
      const [jobSnap, refundSnap, outboxSnap] = await Promise.all([
        tx.get(jobRef),
        tx.get(refundRef),
        tx.get(outboxRef),
      ]);
      if (!jobSnap.exists || !refundSnap.exists) {
        throw new DispatchError('DOCUMENT_NOT_FOUND');
      }
      const job = jobSnap.data();
      const refund = refundSnap.data();
      const nowMs = currentMillis();

      if (outboxSnap.exists) {
        const outbox = outboxSnap.data();
        if (!validateRefundConfirmedOutbox(outbox, { jobId: claim.jobId, amountPaise: claim.amount, TimestampClass })) {
          throw new DispatchError('OUTBOX_COLLISION_INVALID');
        }
      }

      if (refund.state === 'confirmed') {
        if (!validateConfirmedOccurrence(job, refund, claim, TimestampClass, nowMs)) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        if (!outboxSnap.exists || !validateRefundConfirmedOutbox(outboxSnap.data(), { jobId: claim.jobId, amountPaise: claim.amount, TimestampClass })) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        if (response && response.id && refund.razorpayRefundId !== response.id) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        if (fetchError && (fetchError instanceof ProviderResponseError || fetchError.name === 'ProviderResponseError' || classifyProviderError(fetchError).code === 'PROVIDER_RESPONSE_INVALID')) {
          throw new DispatchError('CONFIRMED_WINNER_INVALID');
        }
        return { status: 'confirmed', reconciled: true };
      }

      if (refund.state !== 'submitted') {
        throw new DispatchError('IN_FLIGHT_MUTATION_DETECTED');
      }

      if (refund.ownerToken !== claim.ownerToken) {
        return { status: refund.state, reconciled: false, reason: 'lease_lost' };
      }

      // Revalidate in-flight mutation against claim evidence
      if (
        !safeTimestampsEqual(refund.leaseUntil, claim.leaseUntil, TimestampClass) ||
        refund.attemptCount !== claim.attemptCount ||
        refund.reconciliationAttempts !== claim.reconciliationAttempts ||
        !safeTimestampsEqual(refund.submittedAt, claim.submittedAt, TimestampClass) ||
        !safeTimestampsEqual(refund.createdAt, claim.createdAt, TimestampClass) ||
        !safeTimestampsEqual(refund.updatedAt, claim.updatedAt, TimestampClass) ||
        !safeTimestampsEqual(refund.reconciliationNextAttemptAt, claim.reconciliationNextAttemptAt, TimestampClass) ||
        refund.confirmationSource !== null ||
        refund.confirmedAt !== null ||
        refund.razorpayRefundId !== claim.refundId ||
        job.bookingFeePaise !== claim.amount ||
        job.razorpayPaymentId !== claim.paymentId ||
        job.razorpayRefundId !== claim.refundId ||
        job.status !== 'cancelled_system' ||
        job.cancellationReason !== 'no_driver_found' ||
        job.refundRequestId !== claim.jobId ||
        job.dispatchState !== 'closed' ||
        job.cancelledBy !== 'system' ||
        job.refundState !== 'submitted' ||
        (job.refundConfirmedAt !== null && job.refundConfirmedAt !== undefined) ||
        (job.refundedAmountPaise !== null && job.refundedAmountPaise !== undefined) ||
        !safeTimestampsEqual(job.refundNextAttemptAt, refund.reconciliationNextAttemptAt, TimestampClass) ||
        !validateRefundRequestLifecycle(refund, {
          jobId: claim.jobId,
          bookingFeePaise: claim.amount,
          razorpayPaymentId: claim.paymentId,
          TimestampClass,
          nowMs,
        }) ||
        !validateJobRefundProjection(job, refund, { TimestampClass, nowMs })
      ) {
        throw new DispatchError('IN_FLIGHT_MUTATION_DETECTED');
      }

      const at = TimestampClass.fromMillis(nowMs);

      if (response) {
        if (response.status === 'processed') {
          // Chronology checks
          if (
            !timestampsInOrder(job.paymentConfirmedAt, at, TimestampClass) ||
            !timestampsInOrder(refund.createdAt, at, TimestampClass) ||
            !timestampsInOrder(refund.submittedAt, at, TimestampClass)
          ) {
            throw new DispatchError('LIFECYCLE_TIMESTAMP_INVALID');
          }

          // Converge to confirmed
          if (!outboxSnap.exists) {
            tx.set(outboxRef, {
              eventId: outboxId,
              eventType: 'refund_confirmed',
              resourceType: 'refund_request',
              resourceId: claim.jobId,
              channel: 'whatsapp',
              recipientKey: 'customer:' + claim.jobId,
              payloadVersion: 1,
              payload: {
                jobId: claim.jobId,
                jobStatus: 'cancelled_system',
                refundAmountPaise: claim.amount,
              },
              state: 'pending',
              ownerToken: null,
              leaseUntil: null,
              nextAttemptAt: at,
              attemptCount: 0,
              providerMessageId: null,
              lastErrorCode: null,
              createdAt: at,
              updatedAt: at,
              sentAt: null,
            });
          }
          tx.update(refundRef, {
            state: 'confirmed',
            confirmationSource: 'reconciliation',
            confirmedAt: at,
            ownerToken: null,
            leaseUntil: null,
            nextAttemptAt: null,
            reconciliationNextAttemptAt: null,
            lastErrorCode: null,
            updatedAt: at,
          });
          tx.update(jobRef, {
            refundState: 'confirmed',
            razorpayRefundId: claim.refundId,
            refundConfirmedAt: at,
            refundedAmountPaise: claim.amount,
            refundNextAttemptAt: null,
            updatedAt: at,
          });
          return { status: 'confirmed', reconciled: true };
        }

        if (response.status === 'failed') {
          // Converge to failed_terminal
          tx.update(refundRef, {
            state: 'failed_terminal',
            lastErrorCode: 'PROVIDER_REFUND_FAILED',
            ownerToken: null,
            leaseUntil: null,
            nextAttemptAt: null,
            reconciliationNextAttemptAt: null,
            updatedAt: at,
          });
          tx.update(jobRef, {
            refundState: 'failed_terminal',
            refundNextAttemptAt: null,
            updatedAt: at,
          });
          return { status: 'failed_terminal', reconciled: true };
        }

        // Response status pending
        const attempts = claim.reconciliationAttempts + 1;
        const backoffMs = calculateReconciliationBackoffMs(attempts);
        const nextDue = TimestampClass.fromMillis(nowMs + backoffMs);

        tx.update(refundRef, {
          reconciliationAttempts: attempts,
          reconciliationNextAttemptAt: nextDue,
          lastErrorCode: null,
          ownerToken: null,
          leaseUntil: null,
          updatedAt: at,
        });
        tx.update(jobRef, {
          refundNextAttemptAt: nextDue,
          updatedAt: at,
        });
        return { status: 'submitted', reconciled: true, pending: true };
      }

      // Fetch error (e.g. transient network or provider 5xx)
      const attempts = claim.reconciliationAttempts + 1;
      const backoffMs = calculateReconciliationBackoffMs(attempts);
      const nextDue = TimestampClass.fromMillis(nowMs + backoffMs);
      const classified = classifyProviderError(fetchError);

      tx.update(refundRef, {
        reconciliationAttempts: attempts,
        reconciliationNextAttemptAt: nextDue,
        lastErrorCode: classified.code,
        ownerToken: null,
        leaseUntil: null,
        updatedAt: at,
      });
      tx.update(jobRef, {
        refundNextAttemptAt: nextDue,
        updatedAt: at,
      });
      return { status: 'submitted', reconciled: false, error: classified.code };
    });
  }

  async function reconcileRefunds({ batchSize = 25 } = {}) {
    const nowMs = currentMillis();
    const nowTimestamp = TimestampClass.fromMillis(nowMs);
    const counts = { discovered: 0, initiated: 0, reconciled: 0, failed: 0 };

    // Query 1: Due pending/retry_wait requests
    for (const state of ['pending', 'retry_wait']) {
      let lastDoc = null;
      while (counts.initiated < batchSize) {
        let q = db.collection('refund_requests')
          .where('state', '==', state)
          .where('nextAttemptAt', '<=', nowTimestamp)
          .orderBy('nextAttemptAt')
          .limit(batchSize);
        if (lastDoc) {
          q = q.startAfter(lastDoc);
        }
        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await processRefundIntent(doc.id);
            if (res?.claimed || res?.finalized) counts.initiated++;
          } catch {
            counts.failed++;
          }
          if (counts.initiated >= batchSize) break;
        }
        if (counts.initiated >= batchSize || snap.docs.length < batchSize) break;
      }
    }

    // Query 2: Due submitted reconciliation
    {
      let lastDoc = null;
      while (counts.reconciled < batchSize) {
        let q = db.collection('refund_requests')
          .where('state', '==', 'submitted')
          .where('reconciliationNextAttemptAt', '<=', nowTimestamp)
          .orderBy('reconciliationNextAttemptAt')
          .limit(batchSize);
        if (lastDoc) {
          q = q.startAfter(lastDoc);
        }
        const subSnap = await q.get();
        if (subSnap.empty) break;

        for (const doc of subSnap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await reconcileSubmittedRefund(doc.id);
            if (res?.reconciled) counts.reconciled++;
          } catch {
            counts.failed++;
          }
          if (counts.reconciled >= batchSize) break;
        }
        if (counts.reconciled >= batchSize || subSnap.docs.length < batchSize) break;
      }
    }

    // Query 3: Expired in_progress leases
    {
      let lastDoc = null;
      while (counts.initiated < batchSize) {
        let q = db.collection('refund_requests')
          .where('state', '==', 'in_progress')
          .where('leaseUntil', '<=', nowTimestamp)
          .orderBy('leaseUntil')
          .limit(batchSize);
        if (lastDoc) {
          q = q.startAfter(lastDoc);
        }
        const expSnap = await q.get();
        if (expSnap.empty) break;

        for (const doc of expSnap.docs) {
          counts.discovered++;
          lastDoc = doc;
          try {
            const res = await processRefundIntent(doc.id);
            if (res?.claimed || res?.finalized) counts.initiated++;
          } catch {
            counts.failed++;
          }
          if (counts.initiated >= batchSize) break;
        }
        if (counts.initiated >= batchSize || expSnap.docs.length < batchSize) break;
      }
    }

    return counts;
  }

  return {
    processRefundIntent,
    reconcileSubmittedRefund,
    reconcileRefunds,
    classifyProviderError,
    calculateBackoffMs,
    calculateReconciliationBackoffMs,
    shouldProcessRefundIntent,
    validateEligibility,
  };
}

let defaultManager = null;
function getDefaultNoDriverRefundManager() {
  if (!defaultManager) {
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();
    defaultManager = createNoDriverRefundManager({
      db,
      TimestampClass: Timestamp,
      now: () => new Date(),
    });
  }
  return defaultManager;
}

module.exports = {
  createNoDriverRefundManager,
  getDefaultNoDriverRefundManager,
  productionNoDriverRefundManager: getDefaultNoDriverRefundManager,
  shouldProcessRefundIntent,
  classifyProviderError,
  calculateBackoffMs,
  calculateReconciliationBackoffMs,
  validateRefundConfirmedOutbox,
  REFUND_REQUEST_KEYS,
  REFUND_ALLOWED_STATES,
  STAGE9_ALLOWED_ERROR_CODES,
  isValidRefundId,
  validateRefundRequestRecord,
  validateRefundRequestLifecycle,
  validateJobRefundProjection,
  validateCanonicalRefundOccurrence,
  validateConfirmedOccurrence,
  validateConfirmedWinner,
  compareTimestamps: safeCompareTimestamps,
  timestampsEqual: safeTimestampsEqual,
  safeTimestampsEqual,
  safeTimestampLessThanOrEqual,
  timestampsInOrder,
  isAuthoritativeTimestamp,
};
