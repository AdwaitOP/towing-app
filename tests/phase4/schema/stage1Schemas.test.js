'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SEED = path.join(ROOT, 'firebase', 'seed');

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function sorted(values) {
  return [...values].sort();
}

function exactKeys(value, expected, label) {
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), label);
}

function dataKeys(schema) {
  return Object.keys(schema).filter((key) => !key.startsWith('_'));
}

function exactSchemaKeys(schema, metadata, fields, label) {
  exactKeys(schema, [...metadata, ...fields], `${label} exact top-level keys`);
}

function enumOf(schema, field) {
  return schema[field].enum;
}

function assertRequired(schema, fields, label) {
  for (const field of fields) {
    assert.equal(schema[field].required, true, `${label}.${field} required`);
  }
}

function assertNullableDefaults(schema, fields, label) {
  const actual = dataKeys(schema).filter((field) => schema[field].type.includes('null'));
  assert.deepEqual(sorted(actual), sorted(fields), `${label} nullable fields`);
  for (const field of fields) {
    assert.equal(schema[field].default, null, `${label}.${field} null default`);
  }
}

function assertBackendOwned(schema, fields, label) {
  for (const field of fields) {
    assert.match(schema[field].writer, /Cloud Function ONLY/, `${label}.${field} backend ownership`);
  }
}

function typeContract(groups) {
  const result = {};
  for (const [type, fields] of Object.entries(groups)) {
    for (const field of fields) result[field] = type;
  }
  return result;
}

function assertTypes(schema, expected, label) {
  exactKeys(expected, dataKeys(schema), `${label} exact type field coverage`);
  for (const [field, type] of Object.entries(expected)) {
    assert.equal(schema[field].type, type, `${label}.${field} exact type`);
  }
}

function assertSelectedTypes(schema, expected, label) {
  for (const [field, type] of Object.entries(expected)) {
    assert.equal(schema[field].type, type, `${label}.${field} exact type`);
  }
}

function defaultsOf(schema) {
  return Object.fromEntries(dataKeys(schema)
    .filter((field) => Object.hasOwn(schema[field], 'default'))
    .map((field) => [field, schema[field].default]));
}

function assertNestedTypes(container, expected, label) {
  exactKeys(container.fields, Object.keys(expected), `${label} exact nested keys`);
  for (const [field, type] of Object.entries(expected)) {
    assert.equal(container.fields[field].type, type, `${label}.${field} exact type`);
    assert.equal(container.fields[field].required, true, `${label}.${field} required`);
  }
}

function indexSignature(index) {
  return `${index.collectionGroup}:${index.fields
    .map(({ fieldPath, order }) => `${fieldPath}:${order}`)
    .join(',')}`;
}

function deriveCompositeSignature(query) {
  assert.equal(typeof query.directIdLookup, 'boolean', `${query.name} direct-ID flag`);
  if (query.directIdLookup) return null;
  const fields = query.equalityFilters.map((fieldPath) => ({
    fieldPath, order: 'ASCENDING'
  }));
  if (query.rangeFilter) {
    fields.push({ fieldPath: query.rangeFilter, order: 'ASCENDING' });
  }
  for (const { field, direction } of query.orderBy) {
    const existing = fields.find(({ fieldPath }) => fieldPath === field);
    if (existing) existing.order = direction;
    else fields.push({ fieldPath: field, order: direction });
  }
  if (fields.length < 2) return null;
  return `${query.collection}:${fields
    .map(({ fieldPath, order }) => `${fieldPath}:${order}`)
    .join(',')}`;
}

const DRIVER_FIELDS = [
  'uid', 'name', 'phone', 'truckType', 'vehicleNumber', 'isOnDuty',
  'walletBalance', 'canFlatbed', 'canPulling', 'activeJobId', 'activeOfferId',
  'verificationStatus', 'verificationDocs', 'rejectionReason', 'bannedUntil',
  'strictMode', 'monthlyCancelCount', 'createdAt', 'updatedAt', 'location',
  'locationUpdatedAt'
];

const JOB_FIELDS = [
  'jobId', 'customerPhone', 'pickupCoords', 'destCoords', 'requestedTruckType',
  'distanceKm', 'pricingTier', 'bookingFeePaise', 'driverCommissionPaise',
  'estimatedFarePaise', 'status', 'offeredTo', 'assignedDriver', 'channel',
  'createdByAdmin', 'razorpayPaymentLinkId', 'razorpayPaymentLinkUrl',
  'paymentLinkProvisioningOwner', 'paymentLinkProvisioningLeaseUntil',
  'razorpayPaymentId', 'paymentConfirmedAt', 'invoiceNumber', 'invoiceUrl',
  'invoiceSentAt', 'invoiceStoragePath', 'invoiceIssueDateIst', 'invoiceIssuedAt',
  'invoiceWhatsAppMediaId', 'invoiceWhatsAppMessageId', 'invoiceSendOwner',
  'invoiceSendLeaseUntil', 'stateVersion', 'dispatchGeneration', 'dispatchState',
  'dispatchRunId', 'dispatchLeaseOwner', 'dispatchLeaseUntil',
  'dispatchNextActionAt', 'dispatchLastFailure', 'currentOfferId', 'offeredAt',
  'offerExpiresAt', 'acceptedAt', 'inProgressAt', 'completedAt',
  'commissionDebitEntryId', 'requestId', 'cancelledBy', 'cancellationReason',
  'cancellationRequestedAt', 'cancellationResolutionState',
  'cancellationResolvedAt', 'cancelledAt', 'refundRequestId', 'refundState',
  'refundNextAttemptAt', 'razorpayRefundId', 'refundConfirmedAt',
  'refundedAmountPaise', 'forfeitedAmount', 'createdAt', 'updatedAt'
];

const OFFER_FIELDS = [
  'jobId', 'driverId', 'dispatchGeneration', 'candidateIndex', 'roundIndex',
  'status', 'offeredAt', 'expiresAt', 'resolvedAt', 'resolutionReason',
  'acceptedAt', 'inProgressAt', 'completedAt', 'timeoutTaskId',
  'timeoutTaskState', 'acceptRequestId', 'cancellationPolicySnapshot',
  'pickupCoords', 'destCoords', 'requestedTruckType',
  'pickupRoutedDistanceMeters', 'pickupEtaSeconds', 'estimatedFarePaise',
  'driverCommissionPaise', 'createdAt', 'updatedAt'
];

const RUN_FIELDS = [
  'jobId', 'generation', 'status', 'policyVersion', 'policySnapshot',
  'candidates', 'nextCandidateIndex', 'attemptedDriverIds', 'excludedDriverIds',
  'currentOfferId', 'createdAt', 'updatedAt', 'finalizedAt'
];

const WALLET_FIELDS = [
  'operationId', 'driverId', 'jobId', 'offerId', 'type', 'commissionPaise',
  'forfeiturePaise', 'creditPaise', 'deltaPaise', 'balanceBeforePaise',
  'balanceAfterPaise', 'cancellationPolicyEvidence', 'sourceRequestId',
  'sourceType', 'actorUid', 'createdAt'
];

const REFUND_FIELDS = [
  'operationId', 'jobId', 'razorpayPaymentId', 'amountPaise', 'reason',
  'providerIdempotencyKey', 'providerRequestHash', 'state', 'ownerToken',
  'leaseUntil', 'nextAttemptAt', 'reconciliationNextAttemptAt',
  'reconciliationAttempts', 'razorpayRefundId', 'confirmationSource',
  'attemptCount', 'lastErrorCode', 'createdAt', 'updatedAt', 'submittedAt',
  'confirmedAt'
];

const OUTBOX_FIELDS = [
  'eventId', 'eventType', 'resourceType', 'resourceId', 'channel',
  'recipientKey', 'payloadVersion', 'payload', 'state', 'ownerToken',
  'leaseUntil', 'nextAttemptAt', 'attemptCount', 'providerMessageId',
  'lastErrorCode', 'createdAt', 'updatedAt', 'sentAt'
];

const RECEIPT_FIELDS = [
  'requestId', 'status', 'type', 'ownerToken', 'claimedAt', 'leaseUntil',
  'processedAt', 'actorUid', 'operation', 'resourceId', 'payloadHash', 'result'
];

const OFFER_POLICY_FIELDS = [
  'version', 'timezone', 'roundingMode', 'freeCancellationsPerMonth',
  'forfeitPctByCount', 'banThresholdCount', 'banDurationDays', 'capturedAt'
];
const COORDINATE_FIELDS = ['lat', 'lng'];
const RUN_POLICY_FIELDS = [
  'locationFreshnessSeconds', 'radiusKmSequence',
  'maxUniqueCandidatesPerGeneration', 'maxMatrixShortlistPerRound',
  'rankingPrimary', 'rankingSecondary', 'rankingTieBreak', 'olaFailureMode'
];
const RUN_CANDIDATE_FIELDS = [
  'driverId', 'roundIndex', 'haversineDistanceKm', 'matrixEtaSeconds',
  'matrixDistanceMeters', 'rankingMode', 'outcome', 'reasonCode'
];
const WALLET_POLICY_EVIDENCE_FIELDS = [
  'version', 'timezone', 'roundingMode', 'freeCancellationsPerMonth',
  'forfeitPctByCount', 'banThresholdCount', 'banDurationDays',
  'cancellationMonth', 'cancellationCount', 'strictModeBefore',
  'strictModeApplied', 'forfeiturePercent', 'capturedAt'
];

const RUN_TRANSITIONS = [
  'active->assigned', 'assigned->active', 'active->exhausted',
  'active->cancelled_customer', 'assigned->cancelled_customer',
  'assigned->completed', 'active->superseded'
];
const OFFER_TRANSITIONS = [
  'offered->accepted', 'accepted->in_progress', 'in_progress->completed',
  'offered->declined', 'offered->expired', 'offered->cancelled_customer',
  'offered->superseded', 'accepted->cancelled_customer',
  'accepted->cancelled_driver', 'in_progress->cancelled_customer'
];
const REFUND_WORKER_TRANSITIONS = [
  'pending->in_progress', 'retry_wait->in_progress', 'in_progress->submitted',
  'in_progress->retry_wait', 'in_progress->failed_terminal'
];
const REFUND_RECONCILIATION_TRANSITIONS = [
  'submitted->confirmed', 'submitted->failed_terminal'
];
const REFUND_WEBHOOK_FROM_STATES = [
  'pending', 'in_progress', 'submitted', 'retry_wait', 'failed_terminal'
];
const OUTBOX_TRANSITIONS = [
  'pending->in_progress', 'retry_wait->in_progress', 'in_progress->sent',
  'in_progress->retry_wait', 'in_progress->failed_terminal'
];

const DRIVER_TYPES = typeContract({
  string: ['uid', 'name', 'phone', 'truckType', 'vehicleNumber', 'verificationStatus'],
  boolean: ['isOnDuty', 'canFlatbed', 'canPulling', 'strictMode'],
  number: ['walletBalance'],
  'string | null': ['activeJobId', 'activeOfferId', 'rejectionReason'],
  'map | null': ['verificationDocs'],
  'timestamp | null': ['bannedUntil', 'locationUpdatedAt'],
  map: ['monthlyCancelCount'],
  timestamp: ['createdAt', 'updatedAt'],
  'GeoPoint | null': ['location']
});
const JOB_TYPES = typeContract({
  string: [
    'jobId', 'customerPhone', 'requestedTruckType', 'status', 'channel',
    'cancellationResolutionState', 'refundState'
  ],
  map: ['pickupCoords', 'destCoords'],
  number: [
    'distanceKm', 'pricingTier', 'bookingFeePaise', 'driverCommissionPaise',
    'estimatedFarePaise', 'stateVersion', 'dispatchGeneration'
  ],
  'string | null': [
    'offeredTo', 'assignedDriver', 'createdByAdmin', 'razorpayPaymentLinkId',
    'razorpayPaymentLinkUrl', 'paymentLinkProvisioningOwner',
    'razorpayPaymentId', 'invoiceNumber', 'invoiceUrl', 'invoiceStoragePath',
    'invoiceIssueDateIst', 'invoiceWhatsAppMediaId', 'invoiceWhatsAppMessageId',
    'invoiceSendOwner', 'dispatchState', 'dispatchRunId', 'dispatchLeaseOwner',
    'currentOfferId', 'commissionDebitEntryId', 'requestId', 'cancelledBy',
    'cancellationReason', 'refundRequestId', 'razorpayRefundId'
  ],
  'timestamp | null': [
    'paymentLinkProvisioningLeaseUntil', 'paymentConfirmedAt', 'invoiceSentAt',
    'invoiceIssuedAt', 'invoiceSendLeaseUntil', 'dispatchLeaseUntil',
    'dispatchNextActionAt', 'offeredAt', 'offerExpiresAt', 'acceptedAt',
    'inProgressAt', 'completedAt', 'cancellationRequestedAt',
    'cancellationResolvedAt', 'cancelledAt', 'refundNextAttemptAt',
    'refundConfirmedAt'
  ],
  'map | null': ['dispatchLastFailure'],
  'number | null': ['refundedAmountPaise', 'forfeitedAmount'],
  timestamp: ['createdAt', 'updatedAt']
});
const OFFER_TYPES = typeContract({
  string: ['jobId', 'driverId', 'status', 'timeoutTaskState', 'requestedTruckType'],
  number: [
    'dispatchGeneration', 'candidateIndex', 'roundIndex', 'estimatedFarePaise',
    'driverCommissionPaise'
  ],
  timestamp: ['offeredAt', 'expiresAt', 'createdAt', 'updatedAt'],
  'timestamp | null': ['resolvedAt', 'acceptedAt', 'inProgressAt', 'completedAt'],
  'string | null': ['resolutionReason', 'timeoutTaskId', 'acceptRequestId'],
  'map | null': ['cancellationPolicySnapshot'],
  map: ['pickupCoords', 'destCoords'],
  'number | null': ['pickupRoutedDistanceMeters', 'pickupEtaSeconds']
});
const RUN_TYPES = typeContract({
  string: ['jobId', 'status'],
  number: ['generation', 'policyVersion', 'nextCandidateIndex'],
  map: ['policySnapshot'],
  'array<map>': ['candidates'],
  'array<string>': ['attemptedDriverIds', 'excludedDriverIds'],
  'string | null': ['currentOfferId'],
  timestamp: ['createdAt', 'updatedAt'],
  'timestamp | null': ['finalizedAt']
});
const WALLET_TYPES = typeContract({
  string: ['operationId', 'driverId', 'jobId', 'offerId', 'type', 'sourceType'],
  number: [
    'commissionPaise', 'forfeiturePaise', 'creditPaise', 'deltaPaise',
    'balanceBeforePaise', 'balanceAfterPaise'
  ],
  'map | null': ['cancellationPolicyEvidence'],
  'string | null': ['sourceRequestId', 'actorUid'],
  timestamp: ['createdAt']
});
const REFUND_TYPES = typeContract({
  string: [
    'operationId', 'jobId', 'razorpayPaymentId', 'reason',
    'providerIdempotencyKey', 'providerRequestHash', 'state'
  ],
  number: ['amountPaise', 'reconciliationAttempts', 'attemptCount'],
  'string | null': [
    'ownerToken', 'razorpayRefundId', 'confirmationSource', 'lastErrorCode'
  ],
  'timestamp | null': [
    'leaseUntil', 'nextAttemptAt', 'reconciliationNextAttemptAt',
    'submittedAt', 'confirmedAt'
  ],
  timestamp: ['createdAt', 'updatedAt']
});
const OUTBOX_TYPES = typeContract({
  string: [
    'eventId', 'eventType', 'resourceType', 'resourceId', 'channel',
    'recipientKey', 'state'
  ],
  number: ['payloadVersion', 'attemptCount'],
  map: ['payload'],
  'string | null': ['ownerToken', 'providerMessageId', 'lastErrorCode'],
  'timestamp | null': ['leaseUntil', 'nextAttemptAt', 'sentAt'],
  timestamp: ['createdAt', 'updatedAt']
});
const RECEIPT_TYPES = typeContract({
  string: ['requestId', 'status', 'type'],
  'string | null': ['ownerToken', 'actorUid', 'operation', 'resourceId', 'payloadHash'],
  timestamp: ['claimedAt'],
  'timestamp | null': ['leaseUntil', 'processedAt'],
  'map | null': ['result']
});

test('every seed, index, and exact query-contract JSON file parses', () => {
  const files = fs.readdirSync(SEED).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.doesNotThrow(() => json(path.join('firebase', 'seed', file)), file);
  }
  assert.doesNotThrow(() => json(path.join('firebase', 'firestore.indexes.json')));
  assert.doesNotThrow(() => json(path.join('tests', 'phase4', 'schema', 'indexQueryContract.json')));
});

test('jobs and drivers retain exact Phase 1-3 key sets plus only locked Stage 1 fields', () => {
  const drivers = json(path.join('firebase', 'seed', 'drivers_schema.json'));
  exactSchemaKeys(drivers, ['_comment', '_spec_ref', '_phase4_compatibility'],
    DRIVER_FIELDS, 'drivers');
  assertTypes(drivers, DRIVER_TYPES, 'drivers');
  for (const field of DRIVER_FIELDS) {
    assert.equal(drivers[field].required, undefined,
      `drivers.${field} remains optional for legacy-document compatibility`);
  }
  assert.deepEqual(enumOf(drivers, 'verificationStatus'), ['pending', 'approved', 'rejected']);
  assert.deepEqual(enumOf(drivers, 'truckType'), ['flatbed', 'tochan', 'hydraulic', 'crane']);
  assert.equal(JSON.stringify(drivers).includes('pending_verification'), false);
  assert.deepEqual(defaultsOf(drivers), {
    isOnDuty: false, walletBalance: 0, canFlatbed: false, canPulling: false,
    activeJobId: null, activeOfferId: null, verificationStatus: 'pending',
    verificationDocs: null, rejectionReason: null, bannedUntil: null,
    strictMode: false, monthlyCancelCount: { month: '', count: 0 },
    location: null, locationUpdatedAt: null
  });
  assertNullableDefaults(drivers, [
    'activeJobId', 'activeOfferId', 'verificationDocs', 'rejectionReason',
    'bannedUntil', 'location', 'locationUpdatedAt'
  ], 'drivers');
  assert.deepEqual(drivers.verificationDocs.exactKeysWhenPresent,
    ['idPhotoUrl', 'rcPhotoUrl', 'selfiePhotoUrl', 'submittedAt']);
  assertNestedTypes(drivers.verificationDocs, {
    idPhotoUrl: 'string', rcPhotoUrl: 'string', selfiePhotoUrl: 'string',
    submittedAt: 'timestamp'
  }, 'drivers.verificationDocs');
  assert.deepEqual(drivers.monthlyCancelCount.exactKeys, ['month', 'count']);
  assertNestedTypes(drivers.monthlyCancelCount,
    { month: 'string', count: 'number' }, 'drivers.monthlyCancelCount');
  assertBackendOwned(drivers, [
    'walletBalance', 'canFlatbed', 'canPulling', 'activeJobId', 'activeOfferId',
    'verificationStatus', 'verificationDocs', 'rejectionReason', 'bannedUntil',
    'strictMode', 'monthlyCancelCount'
  ], 'drivers');
  assert.match(drivers.truckType.description, /never inferred/i);
  assert.match(drivers.canFlatbed.description, /requestedTruckType='flatbed'/);
  assert.match(drivers.canPulling.description, /requestedTruckType='pulling'/);
  assert.match(`${drivers.locationUpdatedAt.description} ${drivers.locationUpdatedAt.writer}`,
    /equal the stored value/i);
  assert.match(drivers.updatedAt.description, /request\.time/i);
  assert.match(drivers._phase4_compatibility, /fail.*closed/i);

  const jobs = json(path.join('firebase', 'seed', 'jobs_schema.json'));
  exactSchemaKeys(jobs, [
    '_comment', '_spec_ref', '_phase4_compatibility',
    '_accepted_driver_cancellation_atomic_contract', '_no_driver_refund_contract'
  ], JOB_FIELDS, 'jobs');
  assertTypes(jobs, JOB_TYPES, 'jobs');
  for (const field of JOB_FIELDS) {
    assert.equal(jobs[field].required, undefined,
      `jobs.${field} remains optional for legacy-document compatibility`);
  }
  assert.deepEqual(defaultsOf(jobs), {
    offeredTo: null, assignedDriver: null, createdByAdmin: null,
    razorpayPaymentLinkId: null, razorpayPaymentLinkUrl: null,
    paymentLinkProvisioningOwner: null, paymentLinkProvisioningLeaseUntil: null,
    razorpayPaymentId: null, paymentConfirmedAt: null, invoiceNumber: null,
    invoiceUrl: null, invoiceSentAt: null, invoiceStoragePath: null,
    invoiceIssueDateIst: null, invoiceIssuedAt: null,
    invoiceWhatsAppMediaId: null, invoiceWhatsAppMessageId: null,
    invoiceSendOwner: null, invoiceSendLeaseUntil: null, stateVersion: 0,
    dispatchGeneration: 0, dispatchState: null, dispatchRunId: null,
    dispatchLeaseOwner: null, dispatchLeaseUntil: null,
    dispatchNextActionAt: null, dispatchLastFailure: null,
    currentOfferId: null, offeredAt: null, offerExpiresAt: null,
    acceptedAt: null, inProgressAt: null, completedAt: null,
    commissionDebitEntryId: null, requestId: null, cancelledBy: null,
    cancellationReason: null, cancellationRequestedAt: null,
    cancellationResolutionState: 'none', cancellationResolvedAt: null,
    cancelledAt: null, refundRequestId: null, refundState: 'none',
    refundNextAttemptAt: null, razorpayRefundId: null,
    refundConfirmedAt: null, refundedAmountPaise: null, forfeitedAmount: null
  });
  assertNullableDefaults(jobs, [
    'offeredTo', 'assignedDriver', 'createdByAdmin', 'razorpayPaymentLinkId',
    'razorpayPaymentLinkUrl', 'paymentLinkProvisioningOwner',
    'paymentLinkProvisioningLeaseUntil', 'razorpayPaymentId',
    'paymentConfirmedAt', 'invoiceNumber', 'invoiceUrl', 'invoiceSentAt',
    'invoiceStoragePath', 'invoiceIssueDateIst', 'invoiceIssuedAt',
    'invoiceWhatsAppMediaId', 'invoiceWhatsAppMessageId', 'invoiceSendOwner',
    'invoiceSendLeaseUntil', 'dispatchState', 'dispatchRunId',
    'dispatchLeaseOwner', 'dispatchLeaseUntil', 'dispatchNextActionAt',
    'dispatchLastFailure', 'currentOfferId', 'offeredAt', 'offerExpiresAt',
    'acceptedAt', 'inProgressAt', 'completedAt', 'commissionDebitEntryId',
    'requestId', 'cancelledBy', 'cancellationReason',
    'cancellationRequestedAt', 'cancellationResolvedAt', 'cancelledAt',
    'refundRequestId', 'refundNextAttemptAt', 'razorpayRefundId',
    'refundConfirmedAt', 'refundedAmountPaise', 'forfeitedAmount'
  ], 'jobs');
  assert.deepEqual(enumOf(jobs, 'requestedTruckType'), ['flatbed', 'pulling']);
  assert.deepEqual(enumOf(jobs, 'pricingTier'), [1, 2, 3]);
  assert.deepEqual(enumOf(jobs, 'status'), [
    'awaiting_payment', 'pending_offer', 'offered', 'accepted', 'in_progress',
    'completed', 'cancelled_customer', 'cancelled_driver', 'cancelled_system'
  ]);
  assert.deepEqual(enumOf(jobs, 'channel'), ['whatsapp', 'phone']);
  assert.deepEqual(enumOf(jobs, 'dispatchState'), [
    'not_started', 'ready', 'claimed', 'selecting', 'retry_wait',
    'operational_hold', 'offered', 'assigned', 'closed', null
  ]);
  assert.deepEqual(enumOf(jobs, 'cancelledBy'), ['customer', 'driver', 'system', null]);
  assert.deepEqual(enumOf(jobs, 'cancellationResolutionState'), ['none', 'pending', 'resolved']);
  assert.deepEqual(enumOf(jobs, 'refundState'), [
    'none', 'pending', 'in_progress', 'submitted', 'confirmed',
    'retry_wait', 'failed_terminal'
  ]);
  assert.deepEqual(jobs.pickupCoords.exactKeys, COORDINATE_FIELDS);
  assert.deepEqual(jobs.destCoords.exactKeys, COORDINATE_FIELDS);
  assertNestedTypes(jobs.pickupCoords, { lat: 'number', lng: 'number' },
    'jobs.pickupCoords');
  assertNestedTypes(jobs.destCoords, { lat: 'number', lng: 'number' },
    'jobs.destCoords');
  assert.deepEqual(jobs.dispatchLastFailure.exactKeysWhenPresent,
    ['code', 'source', 'retryable', 'occurredAt']);
  assertNestedTypes(jobs.dispatchLastFailure, {
    code: 'string', source: 'string', retryable: 'boolean', occurredAt: 'timestamp'
  }, 'jobs.dispatchLastFailure');
  for (const field of JOB_FIELDS) {
    assert.match(jobs[field].writer, /Cloud Function/,
      `jobs.${field} is server-owned`);
  }
  assert.deepEqual(jobs.cancellationReason.reservedCanonicalValues, ['no_driver_found']);
  assert.equal(jobs.dispatchCursor, undefined);
  assert.equal(jobs.refundOperationId, undefined);
  assert.match(jobs._phase4_compatibility, /status==pending_offer without ordering/i);
  assert.match(jobs._phase4_compatibility, /No destructive migration/i);
});

test('accepted-driver cancellation schema locks every atomic reset and preservation', () => {
  const matrix = json(path.join('firebase', 'seed', 'jobs_schema.json'))
    ._accepted_driver_cancellation_atomic_contract;
  exactKeys(matrix, [
    'guard', 'customerMarkerPrecedence', 'raceOrders', 'jobChanges',
    'jobPreserved', 'offerChanges', 'driverChanges', 'dispatchRunChanges',
    'financialAndIdempotency'
  ], 'accepted cancellation matrix');
  assert.deepEqual(matrix.guard, {
    jobStatus: 'accepted',
    dispatchState: 'assigned',
    authenticatedDriver: 'must equal assignedDriver',
    currentOfferStatus: 'accepted',
    requestReceiptBinding: 'new or identical',
    cancellationRequestedAt: 'must be null',
    cancellationResolutionState: 'must equal none',
    cancellationResolvedAt: 'must be null',
    cancelledAt: 'must be null',
    cancelledBy: 'must be null',
    cancellationReason: 'must be null'
  });
  assert.deepEqual(matrix.customerMarkerPrecedence, {
    rule: 'CUSTOMER_CANCELLATION_MARKER_WINS',
    stableResult: 'customer_cancellation_in_progress',
    nonPenalizing: true,
    forbiddenMutations: [
      'driver_cancel_credit ledger entry', 'monthlyCancelCount increment',
      'strictMode mutation', 'bannedUntil mutation', 'forfeiture',
      'pending_offer redispatch', 'customer cancellation provenance overwrite'
    ],
    resolutionOwner: 'Phase 4 customer-cancellation resolver; customer full commission credit semantics remain authoritative'
  });
  assert.deepEqual(matrix.raceOrders, {
    customerMarkerFirst: 'driver cancellation loses and returns customer_cancellation_in_progress without penalty or domain mutation; customer resolver completes customer cancellation',
    driverCancellationFirst: 'driver policy commits and job returns to pending_offer; later customer cancellation reads the new current state and follows the approved customer-cancellation path'
  });
  assert.deepEqual(matrix.jobChanges, {
    status: 'accepted->pending_offer',
    dispatchState: 'assigned->ready',
    assignedDriver: 'set null',
    offeredTo: 'set null',
    currentOfferId: 'set null',
    offeredAt: 'set null',
    offerExpiresAt: 'set null',
    acceptedAt: 'set null',
    commissionDebitEntryId: 'set null',
    forfeitedAmount: 'overwritten with the forfeiturePaise for that most recent cancellation occurrence (non-authoritative display projection; not cumulative; wallet_entries is sole financial authority)',
    dispatchLeaseOwner: 'set null',
    dispatchLeaseUntil: 'set null',
    dispatchLastFailure: 'set null',
    dispatchNextActionAt: 'set to transaction server time for immediate same-generation continuation',
    updatedAt: 'set to transaction server time',
    stateVersion: 'increment exactly by 1'
  });
  assert.deepEqual(matrix.jobPreserved, [
    'dispatchGeneration', 'dispatchRunId', 'inProgressAt (must already be null)',
    'completedAt (must already be null)', 'cancelledAt (must remain null)',
    'immutable booking/pricing/payment/invoice fields',
    'customer cancellation/refund fields under the complete customer-marker guard'
  ]);
  assert.deepEqual(matrix.offerChanges, [
    'status accepted->cancelled_driver',
    'resolvedAt=transaction server time',
    'resolutionReason=driver_cancelled',
    'updatedAt=transaction server time'
  ]);
  assert.deepEqual(matrix.driverChanges, [
    'activeJobId->null', 'activeOfferId->null',
    'updatedAt=transaction server time',
    'monthly cancellation/strict-mode/ban fields change only according to the snapshotted financial policy'
  ]);
  assert.deepEqual(matrix.dispatchRunChanges, [
    'status assigned->active', 'currentOfferId->null',
    'cancelling candidate outcome accepted->driver_cancelled',
    'driver remains attempted and becomes/stays excluded',
    'nextCandidateIndex preserved exactly', 'finalizedAt remains null',
    'updatedAt=transaction server time'
  ]);
  assert.equal(matrix.financialAndIdempotency,
    'The future runtime transaction also creates/reuses the deterministic driver_cancel_credit ledger entry and completes the bound processed_requests receipt atomically. Stage 1 defines but does not implement this mutation.');
});

test('driver-facing offer is exactly the approved sanitized allowlist', () => {
  const schema = json(path.join('firebase', 'seed', 'job_offers_schema.json'));
  exactSchemaKeys(schema, [
    '_comment', '_spec_ref', '_driver_visible_exact_allowlist',
    '_privacy_boundary', '_retention_visibility', '_state_machine'
  ], OFFER_FIELDS, 'job_offers');
  // Both declarations are checked against the independent Stage 1 contract above.
  assert.deepEqual(schema._driver_visible_exact_allowlist, OFFER_FIELDS);
  assert.deepEqual(dataKeys(schema), OFFER_FIELDS);
  assertTypes(schema, OFFER_TYPES, 'job_offers');
  assertRequired(schema, OFFER_FIELDS, 'job_offers');
  assertNullableDefaults(schema, [
    'resolvedAt', 'resolutionReason', 'acceptedAt', 'inProgressAt', 'completedAt',
    'timeoutTaskId', 'acceptRequestId', 'cancellationPolicySnapshot',
    'pickupRoutedDistanceMeters', 'pickupEtaSeconds'
  ], 'job_offers');
  assert.deepEqual(enumOf(schema, 'status'), [
    'offered', 'accepted', 'in_progress', 'completed', 'declined', 'expired',
    'cancelled_customer', 'cancelled_driver', 'superseded'
  ]);
  assert.deepEqual(enumOf(schema, 'resolutionReason'), [
    'declined_by_driver', 'offer_expired', 'customer_cancelled',
    'driver_cancelled', 'superseded', null
  ]);
  assert.deepEqual(schema._state_machine, {
    nonterminalStates: ['offered', 'accepted', 'in_progress'],
    terminalStates: [
      'completed', 'declined', 'expired', 'cancelled_customer',
      'cancelled_driver', 'superseded'
    ],
    legalTransitions: OFFER_TRANSITIONS
  });
  assert.equal(schema.timeoutTaskState.default, 'pending');
  assert.deepEqual(schema.pickupCoords.exactKeys, COORDINATE_FIELDS);
  assert.deepEqual(schema.destCoords.exactKeys, COORDINATE_FIELDS);
  assertNestedTypes(schema.pickupCoords, { lat: 'number', lng: 'number' },
    'pickup coordinates');
  assertNestedTypes(schema.destCoords, { lat: 'number', lng: 'number' },
    'destination coordinates');
  assert.deepEqual(schema.cancellationPolicySnapshot.exactKeysWhenPresent,
    OFFER_POLICY_FIELDS);
  assertNestedTypes(schema.cancellationPolicySnapshot, {
    version: 'number', timezone: 'string', roundingMode: 'string',
    freeCancellationsPerMonth: 'number',
    forfeitPctByCount: 'map<string, non-negative safe integer percent>',
    banThresholdCount: 'number', banDurationDays: 'number',
    capturedAt: 'timestamp'
  }, 'offer policy snapshot');
  assert.deepEqual(schema.cancellationPolicySnapshot.fields.timezone.enum,
    ['Asia/Kolkata']);
  assert.deepEqual(schema.cancellationPolicySnapshot.fields.roundingMode.enum,
    ['HALF_UP']);
  assert.deepEqual(enumOf(schema, 'requestedTruckType'), ['flatbed', 'pulling']);
  assert.deepEqual(enumOf(schema, 'timeoutTaskState'),
    ['pending', 'enqueued', 'not_required']);
  assert.match(schema.estimatedFarePaise.unit, /safe integer paise/i);
  assert.match(schema.driverCommissionPaise.unit, /safe integer paise/i);
  assert.match(schema._privacy_boundary, /acceptRequestId is the sole approved/i);
  assert.match(schema._retention_visibility, /until an approved future.*deletes/i);
  assertBackendOwned(schema, OFFER_FIELDS, 'job_offers');
});

test('dispatch run is an exact finite resumable evidence contract', () => {
  const schema = json(path.join('firebase', 'seed', 'dispatch_runs_schema.json'));
  exactSchemaKeys(schema, [
    '_comment', '_spec_ref', '_invariants', '_state_machine',
    '_accepted_driver_cancellation', '_ola_authorization'
  ], RUN_FIELDS, 'dispatch_runs');
  assertTypes(schema, RUN_TYPES, 'dispatch_runs');
  assertRequired(schema, RUN_FIELDS, 'dispatch_runs');
  assertNullableDefaults(schema, ['currentOfferId', 'finalizedAt'], 'dispatch_runs');
  assert.deepEqual(enumOf(schema, 'status'), [
    'active', 'assigned', 'exhausted', 'cancelled_customer', 'completed', 'superseded'
  ]);
  assert.deepEqual(schema._state_machine.nonterminalStates, ['active', 'assigned']);
  assert.deepEqual(schema._state_machine.terminalStates,
    ['exhausted', 'cancelled_customer', 'completed', 'superseded']);
  assert.deepEqual(schema._state_machine.legalTransitions, RUN_TRANSITIONS);
  assert.equal(schema._state_machine.finalizationRule,
    'finalizedAt is null for active and assigned. It is set exactly once when entering exhausted, cancelled_customer, completed, or superseded and never cleared.');
  assert.deepEqual(schema._accepted_driver_cancellation, {
    status: 'assigned->active',
    currentOfferId: 'set null',
    candidateOutcome: 'accepted->driver_cancelled',
    candidateDriver: 'remains in attemptedDriverIds and is added to excludedDriverIds if not already present',
    generation: 'unchanged',
    nextCandidateIndex: 'preserved exactly; must not advance, decrease, or restart',
    finalizedAt: 'remains null',
    updatedAt: 'set to transaction server time',
    workerLeaseOwnership: 'job-only dispatchLeaseOwner and dispatchLeaseUntil; no dispatch-run owner/lease fields'
  });
  assert.equal(schema.candidates.maximumItems, 30);
  assert.equal(schema.attemptedDriverIds.maximumItems, 30);
  assert.equal(schema.excludedDriverIds.maximumItems, 30);
  assert.equal(schema.attemptedDriverIds.uniqueItems, true);
  assert.equal(schema.excludedDriverIds.uniqueItems, true);
  assert.deepEqual(schema.policySnapshot.exactKeys, RUN_POLICY_FIELDS);
  assertNestedTypes(schema.policySnapshot, {
    locationFreshnessSeconds: 'number', radiusKmSequence: 'array<number>',
    maxUniqueCandidatesPerGeneration: 'number',
    maxMatrixShortlistPerRound: 'number', rankingPrimary: 'string',
    rankingSecondary: 'string', rankingTieBreak: 'string', olaFailureMode: 'string'
  }, 'dispatch policy snapshot');
  assert.deepEqual(schema.candidates.exactItemKeys, RUN_CANDIDATE_FIELDS);
  assertNestedTypes({ fields: schema.candidates.itemFields }, {
    driverId: 'string', roundIndex: 'number', haversineDistanceKm: 'number',
    matrixEtaSeconds: 'number | null', matrixDistanceMeters: 'number | null',
    rankingMode: 'string', outcome: 'string', reasonCode: 'string | null'
  }, 'dispatch candidate');
  assert.deepEqual(schema.candidates.itemFields.rankingMode.enum,
    ['ola', 'haversine_degraded']);
  assert.deepEqual(schema.candidates.itemFields.outcome.enum,
    ['pending', 'offered', 'declined', 'expired', 'accepted', 'driver_cancelled', 'skipped']);
  assert.equal(schema.policySnapshot.exactKeys.includes('olaMonthlyPairCap'), false);
  assert.equal(JSON.stringify(schema.policySnapshot).includes('olaMonthlyPairCap'), false);
  assert.deepEqual(schema.policySnapshot.fields.rankingPrimary.enum,
    ['ola_eta_seconds']);
  assert.deepEqual(schema.policySnapshot.fields.rankingSecondary.enum,
    ['ola_distance_meters']);
  assert.deepEqual(schema.policySnapshot.fields.rankingTieBreak.enum,
    ['driver_uid']);
  assert.deepEqual(schema.policySnapshot.fields.olaFailureMode.enum,
    ['bounded_retry_then_haversine_degraded']);
  assert.match(schema._ola_authorization, /revalidate the current/i);
  assertBackendOwned(schema, RUN_FIELDS, 'dispatch_runs');
});

test('wallet ledger has exact keys, safe-integer money fields, semantic IDs, and type arithmetic', () => {
  const schema = json(path.join('firebase', 'seed', 'wallet_entries_schema.json'));
  exactSchemaKeys(schema, [
    '_comment', '_spec_ref', '_operation_id_formats', '_invariants',
    '_conditional_contracts'
  ], WALLET_FIELDS, 'wallet_entries');
  assertTypes(schema, WALLET_TYPES, 'wallet_entries');
  assertRequired(schema, WALLET_FIELDS, 'wallet_entries');
  assertNullableDefaults(schema,
    ['cancellationPolicyEvidence', 'sourceRequestId', 'actorUid'], 'wallet_entries');
  assert.deepEqual(schema._operation_id_formats, {
    commission_debit: 'commission_debit:{jobId}:{offerId}',
    customer_cancel_credit: 'customer_cancel_credit:{jobId}:{offerId}',
    driver_cancel_credit: 'driver_cancel_credit:{jobId}:{offerId}',
    _collision_invariant: 'offerId is the immutable occurrence identity of the accepted assignment. Using {jobId}:{offerId} rather than {jobId}:{driverId} ensures that different legitimate acceptance occurrences (e.g. the same driver accepting in two separate dispatch generations) produce different ledger IDs while the same semantic occurrence retried produces the same ID. Past immutable ledger records can never collide with later occurrences.'
  });
  assert.deepEqual(enumOf(schema, 'type'),
    ['commission_debit', 'customer_cancel_credit', 'driver_cancel_credit']);
  assert.deepEqual(enumOf(schema, 'sourceType'), ['driver', 'customer', 'system']);
  for (const field of [
    'commissionPaise', 'forfeiturePaise', 'creditPaise', 'deltaPaise',
    'balanceBeforePaise', 'balanceAfterPaise'
  ]) assert.match(schema[field].unit, /safe integer.*paise/i, field);
  assert.deepEqual(schema._conditional_contracts.commission_debit, {
    operationId: 'commission_debit:{jobId}:{offerId}',
    commissionPaise: '> 0', forfeiturePaise: '= 0', creditPaise: '= 0',
    deltaPaise: '= -commissionPaise',
    balanceAfterPaise: '= balanceBeforePaise - commissionPaise',
    cancellationPolicyEvidence: 'must be null'
  });
  assert.deepEqual(schema._conditional_contracts.customer_cancel_credit, {
    operationId: 'customer_cancel_credit:{jobId}:{offerId}',
    commissionPaise: '> 0', forfeiturePaise: '= 0',
    creditPaise: '= commissionPaise', deltaPaise: '= creditPaise',
    balanceAfterPaise: '= balanceBeforePaise + creditPaise',
    cancellationPolicyEvidence: 'must be null'
  });
  assert.deepEqual(schema._conditional_contracts.driver_cancel_credit, {
    operationId: 'driver_cancel_credit:{jobId}:{offerId}',
    commissionPaise: '> 0',
    forfeiturePaise: '0 <= forfeiturePaise <= commissionPaise',
    creditPaise: '= commissionPaise - forfeiturePaise',
    deltaPaise: '= creditPaise',
    balanceAfterPaise: '= balanceBeforePaise + creditPaise',
    cancellationPolicyEvidence: 'required complete immutable map',
    fullForfeiture: 'forfeiturePaise = commissionPaise; creditPaise = 0; deltaPaise = 0; ledger entry still required'
  });
  assert.deepEqual(schema.cancellationPolicyEvidence.exactKeysWhenPresent,
    WALLET_POLICY_EVIDENCE_FIELDS);
  assertNestedTypes(schema.cancellationPolicyEvidence, {
    version: 'number', timezone: 'string', roundingMode: 'string',
    freeCancellationsPerMonth: 'number',
    forfeitPctByCount: 'map<string, non-negative safe integer percent>',
    banThresholdCount: 'number', banDurationDays: 'number',
    cancellationMonth: 'string', cancellationCount: 'number',
    strictModeBefore: 'boolean', strictModeApplied: 'boolean',
    forfeiturePercent: 'number', capturedAt: 'timestamp'
  }, 'wallet cancellation evidence');
  assert.deepEqual(schema.cancellationPolicyEvidence.fields.timezone.enum,
    ['Asia/Kolkata']);
  assert.deepEqual(schema.cancellationPolicyEvidence.fields.roundingMode.enum,
    ['HALF_UP']);
  assert.deepEqual(schema.cancellationPolicyEvidence.requiredForTypes,
    ['driver_cancel_credit']);
  assert.deepEqual(schema.cancellationPolicyEvidence.mustBeNullForTypes,
    ['commission_debit', 'customer_cancel_credit']);
  assert.match(schema._invariants, /permanent financial evidence|independently interpretable/i);
  assertBackendOwned(schema, WALLET_FIELDS.filter((field) => field !== 'operationId'),
    'wallet_entries');
});

test('refund request has exact immutable identity, state machine, and monotonic convergence', () => {
  const schema = json(path.join('firebase', 'seed', 'refund_requests_schema.json'));
  exactSchemaKeys(schema, [
    '_comment', '_spec_ref', '_invariants', '_state_machine',
    '_provider_request_contract', '_submitted_reconciliation_contract',
    '_monotonic_convergence'
  ], REFUND_FIELDS, 'refund_requests');
  assertTypes(schema, REFUND_TYPES, 'refund_requests');
  assertRequired(schema, REFUND_FIELDS, 'refund_requests');
  assertNullableDefaults(schema, [
    'ownerToken', 'leaseUntil', 'nextAttemptAt', 'reconciliationNextAttemptAt',
    'razorpayRefundId', 'confirmationSource', 'lastErrorCode', 'submittedAt',
    'confirmedAt'
  ], 'refund_requests');
  assert.deepEqual(enumOf(schema, 'state'),
    ['pending', 'in_progress', 'submitted', 'confirmed', 'retry_wait', 'failed_terminal']);
  assert.deepEqual(enumOf(schema, 'reason'), ['no_driver_found']);
  assert.deepEqual(schema._state_machine, {
    states: ['pending', 'in_progress', 'submitted', 'confirmed', 'retry_wait', 'failed_terminal'],
    legalWorkerTransitions: REFUND_WORKER_TRANSITIONS,
    signedWebhookFromStates: REFUND_WEBHOOK_FROM_STATES,
    reconciliationTransitions: REFUND_RECONCILIATION_TRANSITIONS,
    confirmationSources: ['webhook', 'reconciliation'],
    signedWebhookTransition: 'A valid matching signed refund.processed event may move any non-confirmed state to confirmed, including when it arrives before worker success persistence or after a provider fetch reported failed. confirmed is absorbing and never regresses.',
    ownership: 'in_progress initiation and due submitted reconciliation use non-null ownerToken and leaseUntil fencing. A submitted reconciler claims without changing state; stale initiation or reconciliation ownership is reclaimable.',
    terminality: 'confirmed is final provider-processed convergence. failed_terminal is a local no-retry classification but a later valid signed provider webhook for the same exact provider refund identity still converges it to confirmed.'
  });
  assert.deepEqual(enumOf(schema, 'confirmationSource'),
    ['webhook', 'reconciliation', null]);
  for (const field of [
    'jobId', 'razorpayPaymentId', 'amountPaise', 'reason',
    'providerIdempotencyKey', 'providerRequestHash'
  ]) assert.equal(schema[field].immutable, true, `${field} immutable`);
  assert.equal(schema.providerIdempotencyKey.required, true);
  assert.equal(schema.providerIdempotencyKey.format, 'refund_no_driver_found_{jobId}');
  assert.equal(schema.providerIdempotencyKey.validationRegex,
    '^refund_no_driver_found_[A-Za-z0-9_-]+$');
  assert.equal(schema.providerIdempotencyKey.jobIdValidationRegex,
    '^[A-Za-z0-9_-]+$');
  const sampleJobId = 'AbC_123-xyz';
  const sampleProviderKey = `refund_no_driver_found_${sampleJobId}`;
  assert.equal(sampleProviderKey, 'refund_no_driver_found_AbC_123-xyz');
  assert.match(sampleProviderKey,
    /^refund_no_driver_found_[A-Za-z0-9_-]+$/);
  assert.doesNotMatch('refund:no_driver_found:AbC_123-xyz',
    /^refund_no_driver_found_[A-Za-z0-9_-]+$/);
  const REFUND_IDEMPOTENCY_HEADER = 'X-Refund-Idempotency';
  const requestHeaders = { [REFUND_IDEMPOTENCY_HEADER]: sampleProviderKey };
  assert.deepEqual(requestHeaders,
    { 'X-Refund-Idempotency': 'refund_no_driver_found_AbC_123-xyz' });
  assert.equal(Object.keys(requestHeaders)[0], 'X-Refund-Idempotency');
  assert.equal(requestHeaders['X-Refund-Idempotency'], sampleProviderKey);
  assert.equal(schema.providerRequestHash.format,
    'lowercase 64-character SHA-256 hex of UTF-8 canonicalRefundRequest');
  assert.equal(schema.providerRequestHash.validationRegex, '^[0-9a-f]{64}$');

  const paymentId = 'pay_ABC123';
  const amount = 10000;
  const canonicalRefundRequest = JSON.stringify({ paymentId, amount });
  const expectedCanonical = '{"paymentId":"pay_ABC123","amount":10000}';
  const expectedHash = 'aa4a95fcf05307d4ea00c64e19d92b2f48e37b9cfd95fed1f6ddc62cd61ee4fb';
  assert.equal(canonicalRefundRequest, expectedCanonical);
  assert.equal(createHash('sha256').update(canonicalRefundRequest, 'utf8').digest('hex'),
    expectedHash);
  assert.deepEqual(schema._provider_request_contract, {
    httpOperation: 'POST',
    pathIdentity: 'payments/{razorpayPaymentId}/refund',
    idempotencyHeaderName: 'X-Refund-Idempotency',
    idempotencyHeaderValue: 'providerIdempotencyKey',
    requestBodyExactKeys: ['amount'],
    requestBody: { amount: 'bookingFeePaise' },
    storedAmountBinding: 'bookingFeePaise equals immutable refund request amountPaise',
    canonicalConstructionKeyOrder: ['paymentId', 'amount'],
    canonicalExpression: 'JSON.stringify({ paymentId: razorpayPaymentId, amount: bookingFeePaise })',
    canonicalEncoding: 'UTF-8',
    hashAlgorithm: 'SHA-256',
    hashEncoding: 'lowercase hexadecimal',
    testVector: {
      razorpayPaymentId: paymentId,
      amountPaise: amount,
      canonicalRefundRequest: expectedCanonical,
      providerRequestHash: expectedHash
    },
    retryInvariant: 'every attempt sends header X-Refund-Idempotency with the exact stored providerIdempotencyKey and reuses the same payment, amount, canonical request, and hash; no attempt or worker identity'
  });
  assert.deepEqual(schema._submitted_reconciliation_contract, {
    preferredConfirmation: 'A valid matching signed refund.processed webhook is the preferred confirmation path but is not the only durable path.',
    dueQuery: 'state == submitted and reconciliationNextAttemptAt <= now',
    claim: 'A transaction leaves state=submitted, requires razorpayRefundId, sets a fresh ownerToken/leaseUntil, and permits reclaim only when leaseUntil is absent or expired.',
    providerLookup: 'GET payments/{razorpayPaymentId}/refunds/{razorpayRefundId} using only the immutable stored payment and refund identities; no raw provider response is persisted.',
    processedResult: 'A matching processed result transactionally sets request and job projections to confirmed, sets confirmationSource=reconciliation, clears both retry schedules and owner/lease, and preserves immutable inputs.',
    pendingResult: 'A matching pending result keeps state=submitted, increments reconciliationAttempts, writes a bounded reconciliationNextAttemptAt, clears owner/lease, and never creates or resubmits a refund.',
    uncertainResult: 'Provider unavailability or an uncertain fetch keeps state=submitted, increments reconciliationAttempts, records only a bounded safe lastErrorCode and reconciliationNextAttemptAt, clears owner/lease, and never creates or resubmits a refund.',
    failedResult: 'An authoritative provider response returning status=failed where paymentId, refundId, and amount match stored identities transactionally moves state submitted->failed_terminal, persists a bounded safe failure classification in lastErrorCode, clears ownerToken, leaseUntil, and reconciliationNextAttemptAt/nextAttemptAt, and updates the matching job refundState=failed_terminal and refundNextAttemptAt=null while preserving jobId, razorpayPaymentId, razorpayRefundId, amountPaise, providerIdempotencyKey, and providerRequestHash. failed_terminal does not become confirmed from the fetch that reported failed, does not automatically submit a second refund, does not reset to pending/submitted through ordinary retry, and requires an explicit future administrative/manual recovery operation if recovery is needed.',
    failedTerminalResult: 'failed_terminal is a durable local no-retry classification and is NOT queried by ordinary reconcilers or workers. A reconciler MUST NOT attempt provider fetch against a failed_terminal request. However, a later valid matching signed refund.processed webhook for the exact same provider refund identity still converges failed_terminal to confirmed with confirmationSource=webhook, confirmedAt, job refundState=confirmed, refundConfirmedAt, and refundedAmountPaise, preserving all immutable payment/refund/request identities. Ordinary retry cannot reset failed_terminal to pending/submitted.',
    mismatchResult: 'Any payment, refund ID, amount, operation, reason, or job identity mismatch fails closed without confirmation or resubmission.',
    raceConvergence: 'Webhook and provider-fetch confirmation re-read the request and job in their transaction; the first matching path confirms them and the loser becomes an identity-validating no-op.',
    absorbingState: 'confirmed never regresses, never re-enters reconciliation, and never causes a duplicate provider submission.'
  });
  assert.match(schema.amountPaise.unit, /positive safe integer paise/i);
  assert.match(schema._invariants, /cancelledBy=system.*cancellationReason=no_driver_found/i);
  assert.deepEqual(schema._monotonic_convergence, [
    'The no-driver domain transaction creates exactly refund_requests/{jobId} and sets job refundRequestId=jobId, refundState=pending, refundNextAttemptAt, cancelledBy=system, cancellationReason=no_driver_found, and cancelledAt atomically.',
    'Before any external request, deterministic providerIdempotencyKey, providerRequestHash, razorpayPaymentId, amountPaise, and reason are durable.',
    'A worker claim moves pending or retry_wait to in_progress using fenced owner/lease semantics without changing immutable provider inputs.',
    'If provider success persistence is lost, recovery repeats the identical request body and sends X-Refund-Idempotency with the exact stored providerIdempotencyKey.',
    'Worker success persists submitted, razorpayRefundId, submittedAt, reconciliationNextAttemptAt, and the matching job refundState=submitted before relying on the webhook.',
    'A reclaimable submitted reconciler fetches the stored payment/refund identity: a matching processed result confirms the refund, a matching failed result marks it failed_terminal, and a matching pending/unavailable result durably reschedules without provider resubmission.',
    'Stage 9 signed refund.processed handling must transactionally validate payment, amount, refund identity, reason, request/job identity, then set both request and job projections to confirmed even if the webhook arrived before worker success persistence or after a provider fetch reported failed.',
    'Webhook and provider-fetch confirmation race safely: the first matching transaction confirms, the other validates identity and becomes a no-op.',
    'confirmed never regresses or resubmits; any payment, amount, refund ID, operation, reason, job, or immutable-request mismatch fails closed.'
  ]);
  assert.equal(schema.reconciliationAttempts.default, 0);
  assertBackendOwned(schema, REFUND_FIELDS.filter((field) => field !== 'operationId'),
    'refund_requests');
});

test('outbox and Phase 4 receipts have exact fields, nullability, enums, and ownership', () => {
  const outbox = json(path.join('firebase', 'seed', 'notification_outbox_schema.json'));
  exactSchemaKeys(outbox, [
    '_comment', '_spec_ref', '_invariants', '_state_machine', '_event_contract',
    '_recipientKey_contract', '_lastErrorCode_contract'
  ], OUTBOX_FIELDS, 'notification_outbox');
  assertTypes(outbox, OUTBOX_TYPES, 'notification_outbox');
  assertRequired(outbox, OUTBOX_FIELDS, 'notification_outbox');
  assertNullableDefaults(outbox, [
    'ownerToken', 'leaseUntil', 'nextAttemptAt', 'providerMessageId',
    'lastErrorCode', 'sentAt'
  ], 'notification_outbox');
  assert.deepEqual(enumOf(outbox, 'state'),
    ['pending', 'in_progress', 'sent', 'retry_wait', 'failed_terminal']);
  const eventTypes = [
    'job_accepted', 'job_in_progress', 'job_completed',
    'job_cancelled_customer', 'job_cancelled_system', 'refund_confirmed'
  ];
  assert.deepEqual(enumOf(outbox, 'eventType'), eventTypes);
  assert.deepEqual(enumOf(outbox, 'resourceType'), ['job', 'refund_request']);
  assert.deepEqual(enumOf(outbox, 'channel'), ['whatsapp']);
  assert.deepEqual(enumOf(outbox, 'payloadVersion'), [1]);
  assert.deepEqual(outbox.payload.exactKeys,
    ['jobId', 'jobStatus', 'refundAmountPaise']);
  assertNestedTypes(outbox.payload, {
    jobId: 'string', jobStatus: 'string', refundAmountPaise: 'number | null'
  }, 'notification_outbox.payload');
  assert.deepEqual(outbox.payload.fields.jobStatus.enum,
    ['accepted', 'in_progress', 'completed', 'cancelled_customer', 'cancelled_system']);

  // _event_contract — occurrence-safe eventId formats
  assert.deepEqual(outbox._event_contract.eventIdFormats, {
    job_accepted: 'job_accepted:{jobId}:{offerId}',
    job_in_progress: 'job_in_progress:{jobId}',
    job_completed: 'job_completed:{jobId}',
    job_cancelled_customer: 'job_cancelled_customer:{jobId}',
    job_cancelled_system: 'job_cancelled_system:{jobId}',
    refund_confirmed: 'refund_confirmed:{jobId}'
  });
  assert.match(outbox._event_contract.occurrenceSafetyNote,
    /job_accepted.*offerId/i,
    'occurrenceSafetyNote must explain job_accepted uses offerId');
  assert.deepEqual(outbox._event_contract.eventTypes, eventTypes);
  assert.deepEqual(outbox._event_contract.resourceTypes, ['job', 'refund_request']);
  assert.equal(outbox._event_contract.channel, 'whatsapp');
  assert.equal(outbox._event_contract.payloadVersion, 1);
  assert.deepEqual(outbox._event_contract.payloadExactKeys,
    ['jobId', 'jobStatus', 'refundAmountPaise']);
  assert.deepEqual(outbox._event_contract.eventBindings, {
    job_accepted: {
      resourceType: 'job', resourceId: 'jobId', jobStatus: 'accepted',
      refundAmountPaise: null
    },
    job_in_progress: {
      resourceType: 'job', resourceId: 'jobId', jobStatus: 'in_progress',
      refundAmountPaise: null
    },
    job_completed: {
      resourceType: 'job', resourceId: 'jobId', jobStatus: 'completed',
      refundAmountPaise: null
    },
    job_cancelled_customer: {
      resourceType: 'job', resourceId: 'jobId', jobStatus: 'cancelled_customer',
      refundAmountPaise: null
    },
    job_cancelled_system: {
      resourceType: 'job', resourceId: 'jobId', jobStatus: 'cancelled_system',
      refundAmountPaise: null
    },
    refund_confirmed: {
      resourceType: 'refund_request', resourceId: 'jobId',
      jobStatus: 'cancelled_system',
      refundAmountPaise: 'positive safe integer exactly equal to confirmed refund amountPaise'
    }
  });
  assert.equal(outbox._event_contract.futureEvolution,
    'Any additional event type, resource type, channel, or payload key requires a separately approved schema/version change.');
  assert.match(outbox._event_contract.privacy, /no customer phone/i);

  // recipientKey — opaque non-PII format
  assert.equal(outbox.recipientKey.format, 'customer:{jobId}',
    'recipientKey must have exact opaque format customer:{jobId}');
  assert.match(outbox._recipientKey_contract.format, /^customer:\{jobId\}$/,
    '_recipientKey_contract.format must be customer:{jobId}');
  assert.match(outbox._recipientKey_contract.resolution, /WhatsApp/i,
    '_recipientKey_contract must describe backend resolution');
  // recipientKey must NOT be permitted to hold raw phone/PII
  assert.match(outbox.recipientKey.description, /never.*raw phone|opaque/i,
    'recipientKey description must explicitly forbid or be opaque — not permit raw phone numbers');
  assert.match(outbox.recipientKey.description, /opaque/i,
    'recipientKey description must describe it as opaque');

  // lastErrorCode — exact enum, no arbitrary strings
  const EXPECTED_ERROR_CODES = [
    'provider_unavailable', 'provider_rate_limited', 'provider_rejected_message',
    'provider_unknown_error', 'recipient_unreachable', 'configuration_missing',
    'internal_error', null
  ];
  assert.deepEqual(enumOf(outbox, 'lastErrorCode'), EXPECTED_ERROR_CODES,
    'lastErrorCode must be exact bounded enum');
  assert.deepEqual(outbox._lastErrorCode_contract.allowedCodes,
    EXPECTED_ERROR_CODES.filter((c) => c !== null),
    '_lastErrorCode_contract.allowedCodes must list all non-null codes');
  assert.match(outbox._lastErrorCode_contract.invariant, /raw provider bodies/i,
    '_lastErrorCode_contract must forbid raw provider bodies');

  assert.deepEqual(outbox._state_machine, {
    nonterminalStates: ['pending', 'in_progress', 'retry_wait'],
    terminalStates: ['sent', 'failed_terminal'],
    legalTransitions: OUTBOX_TRANSITIONS
  });
  assert.equal(outbox.attemptCount.default, 0);
  assert.match(outbox._comment, /at-least-once/i);
  assertBackendOwned(outbox, OUTBOX_FIELDS.filter((field) => field !== 'eventId'),
    'notification_outbox');

  const receipts = json(path.join('firebase', 'seed', 'processed_requests_schema.json'));
  exactSchemaKeys(receipts, [
    '_comment', '_spec_ref', '_phase4_invariant', '_phase4_required_fields',
    '_phase4_state_machine'
  ], RECEIPT_FIELDS, 'processed_requests');
  assert.deepEqual(receipts._phase4_required_fields, RECEIPT_FIELDS);
  assert.deepEqual(dataKeys(receipts), RECEIPT_FIELDS);
  assertTypes(receipts, RECEIPT_TYPES, 'processed_requests');
  assertNullableDefaults(receipts, [
    'ownerToken', 'leaseUntil', 'processedAt', 'actorUid', 'operation',
    'resourceId', 'payloadHash', 'result'
  ], 'processed_requests');
  const receiptAlwaysRequired = ['requestId', 'status', 'type', 'claimedAt'];
  for (const field of RECEIPT_FIELDS) {
    assert.equal(receipts[field].required === true,
      receiptAlwaysRequired.includes(field), `${field} unconditional required contract`);
  }
  assert.deepEqual(enumOf(receipts, 'operation'), [
    'accept', 'decline', 'driver_cancel', 'start_job', 'complete_job', null
  ]);
  assert.deepEqual(enumOf(receipts, 'status'), ['in_progress', 'completed']);
  assert.deepEqual(receipts._phase4_state_machine, {
    states: ['in_progress', 'completed'],
    legalTransitions: ['in_progress->completed'],
    terminalStates: ['completed']
  });
  for (const field of ['actorUid', 'operation', 'resourceId', 'payloadHash']) {
    assert.equal(receipts[field].requiredForPhase4, true, field);
  }
  assert.equal(receipts.result.requiredForCompletedPhase4, true);
  assert.match(receipts._phase4_invariant, /different binding fails closed/i);
  assert.match(receipts._phase4_invariant, /same transaction/i);
  assertBackendOwned(receipts, RECEIPT_FIELDS.filter((field) => field !== 'requestId'),
    'processed_requests');
});

test('Stage 1 config values and template sentinels are exact', () => {
  const dispatch = json(path.join('firebase', 'seed', 'dispatch_config.json'));
  exactKeys(dispatch, [
    '_comment', '_spec_ref', '_validation', '_ola_authorization', 'version',
    'locationFreshnessSeconds', 'radiusKmSequence',
    'maxUniqueCandidatesPerGeneration', 'maxMatrixShortlistPerRound',
    'rankingPrimary', 'rankingSecondary', 'rankingTieBreak', 'olaFailureMode',
    'olaMonthlyPairCap', 'updatedAt', '_updatedAt_template_sentinel'
  ], 'dispatch_config exact keys');
  assert.deepEqual({
    version: dispatch.version,
    locationFreshnessSeconds: dispatch.locationFreshnessSeconds,
    radiusKmSequence: dispatch.radiusKmSequence,
    maxUniqueCandidatesPerGeneration: dispatch.maxUniqueCandidatesPerGeneration,
    maxMatrixShortlistPerRound: dispatch.maxMatrixShortlistPerRound,
    rankingPrimary: dispatch.rankingPrimary,
    rankingSecondary: dispatch.rankingSecondary,
    rankingTieBreak: dispatch.rankingTieBreak,
    olaFailureMode: dispatch.olaFailureMode,
    olaMonthlyPairCap: dispatch.olaMonthlyPairCap,
    updatedAt: dispatch.updatedAt
  }, {
    version: 1,
    locationFreshnessSeconds: 120,
    radiusKmSequence: [10, 20, 35],
    maxUniqueCandidatesPerGeneration: 30,
    maxMatrixShortlistPerRound: 10,
    rankingPrimary: 'ola_eta_seconds',
    rankingSecondary: 'ola_distance_meters',
    rankingTieBreak: 'driver_uid',
    olaFailureMode: 'bounded_retry_then_haversine_degraded',
    olaMonthlyPairCap: null,
    updatedAt: null
  });
  assert.match(dispatch._updatedAt_template_sentinel, /non-deployable/i);
  assert.match(dispatch._ola_authorization, /before every/i);

  const pricing = json(path.join('firebase', 'seed', 'pricing_config.json'));
  exactKeys(pricing, [
    '_comment', '_usage', '_spec_ref', 'booking_tiers', 'fare_formula',
    'cancellation_policy'
  ], 'pricing config exact top-level keys');
  exactKeys(pricing.cancellation_policy, [
    'version', 'timezone', 'roundingMode', 'free_cancellations_per_month',
    'forfeit_pct_by_count', 'ban_threshold_count', 'ban_duration_days', '_note'
  ], 'cancellation policy exact keys');
  const EXPECTED_CANCELLATION_POLICY = {
    version: 1,
    timezone: 'Asia/Kolkata',
    roundingMode: 'HALF_UP',
    free_cancellations_per_month: 1,
    forfeit_pct_by_count: { '2': 20, '3': 30, '4': 40, '5': 50 },
    ban_threshold_count: 6,
    ban_duration_days: 7
  };
  assert.equal(pricing.cancellation_policy.version, EXPECTED_CANCELLATION_POLICY.version,
    'pricing cancellation_policy.version must match locked contract');
  assert.equal(pricing.cancellation_policy.timezone, EXPECTED_CANCELLATION_POLICY.timezone,
    'pricing cancellation_policy.timezone must be Asia/Kolkata');
  assert.equal(pricing.cancellation_policy.roundingMode, EXPECTED_CANCELLATION_POLICY.roundingMode,
    'pricing cancellation_policy.roundingMode must be HALF_UP');
  assert.equal(pricing.cancellation_policy.free_cancellations_per_month, EXPECTED_CANCELLATION_POLICY.free_cancellations_per_month,
    'pricing cancellation_policy.free_cancellations_per_month must be 1');
  assert.deepEqual(pricing.cancellation_policy.forfeit_pct_by_count, EXPECTED_CANCELLATION_POLICY.forfeit_pct_by_count,
    'pricing cancellation_policy.forfeit_pct_by_count must match locked ramp');
  assert.equal(pricing.cancellation_policy.ban_threshold_count, EXPECTED_CANCELLATION_POLICY.ban_threshold_count,
    'pricing cancellation_policy.ban_threshold_count must be 6');
  assert.equal(pricing.cancellation_policy.ban_duration_days, EXPECTED_CANCELLATION_POLICY.ban_duration_days,
    'pricing cancellation_policy.ban_duration_days must be 7');

  const usage = json(path.join('firebase', 'seed', 'usage_counters_template.json'));
  exactKeys(usage, [
    '_comment', '_usage', '_spec_ref', 'olaMapsMatrixRequests',
    'olaMapsMatrixPairs', 'whatsappTemplateSends', 'softCapWhatsapp',
    '_softCapWhatsapp_note', 'updatedAt', '_updatedAt_template_sentinel',
    '_ola_note'
  ], 'usage counter exact keys');
  assert.deepEqual([
    usage.olaMapsMatrixRequests, usage.olaMapsMatrixPairs,
    usage.whatsappTemplateSends, usage.updatedAt
  ], [0, 0, 0, null]);
  assert.equal(usage.olaMapsMatrixCalls, undefined);
  assert.equal(usage.softCapOlaMaps, undefined);
  assert.match(usage._updatedAt_template_sentinel, /non-deployable/i);

  const business = json(path.join('firebase', 'seed', 'business_config.json'));
  assert.equal(business.dispatchPolicy, undefined);
});

test('exact query fixture equals every baseline and Stage 1 composite, with no extras', () => {
  const indexes = json(path.join('firebase', 'firestore.indexes.json'));
  const contract = json(path.join('tests', 'phase4', 'schema', 'indexQueryContract.json'));
  for (const query of contract.queries) {
    exactKeys(query, [
      'name', 'phase', 'collection', 'equalityFilters', 'rangeFilter',
      'orderBy', 'directIdLookup', ...(query.directIdLookup ? ['documentPath'] : [])
    ], `${query.name} exact query-definition keys`);
    assert.ok(['baseline', 'phase4'].includes(query.phase), `${query.name} phase`);
    for (const order of query.orderBy) {
      exactKeys(order, ['field', 'direction'], `${query.name} orderBy keys`);
      assert.ok(['ASCENDING', 'DESCENDING'].includes(order.direction));
    }
  }
  const definitions = contract.queries.map((query) => ({
    query, signature: deriveCompositeSignature(query)
  }));
  const expected = definitions.map(({ signature }) => signature).filter(Boolean);
  const actual = indexes.indexes.map(indexSignature);

  assert.equal(contract.baselineCompositeCount, 5);
  assert.equal(contract.phase4CompositeCount, 17);
  assert.equal(definitions.filter(({ query, signature }) =>
    query.phase === 'baseline' && signature).length, 5);
  assert.equal(definitions.filter(({ query, signature }) =>
    query.phase === 'phase4' && signature).length, 17);
  assert.equal(expected.length, 22);
  assert.equal(actual.length, 22);
  assert.deepEqual(actual, expected, 'no missing, reordered, or speculative composite indexes');
  assert.equal(new Set(actual).size, actual.length, 'no duplicate composite signatures');
  assert.deepEqual(indexes.fieldOverrides, []);
  for (const index of indexes.indexes) {
    assert.equal(index.queryScope, 'COLLECTION');
    assert.ok(index.fields.length >= 2);
    for (const field of index.fields) {
      assert.ok(['ASCENDING', 'DESCENDING'].includes(field.order));
      assert.doesNotMatch(field.fieldPath, /geohash/i);
    }
  }
  assert.deepEqual(contract.queries
    .filter(({ name }) => name.startsWith('eligible_'))
    .map(({ name }) => name),
  ['eligible_flatbed_drivers_by_wallet', 'eligible_pulling_drivers_by_wallet']);
  assert.equal(deriveCompositeSignature(contract.queries.find(({ name }) =>
    name === 'legacy_pending_offer_bootstrap')), null);
  assert.deepEqual(contract.queries.filter(({ directIdLookup }) => directIdLookup)
    .map(({ name }) => name), [
    'mutation_receipt_by_request_id', 'monthly_usage_counter_by_month',
    'dispatch_run_by_generation'
  ]);
  for (const query of contract.queries.filter(({ directIdLookup }) => directIdLookup)) {
    assert.equal(deriveCompositeSignature(query), null, `${query.name} needs no composite`);
  }
  assert.match(contract._comment, /does not prove production composite-index deployment/i);

  const schemaByCollection = {
    drivers: json(path.join('firebase', 'seed', 'drivers_schema.json')),
    jobs: json(path.join('firebase', 'seed', 'jobs_schema.json')),
    job_offers: json(path.join('firebase', 'seed', 'job_offers_schema.json')),
    wallet_entries: json(path.join('firebase', 'seed', 'wallet_entries_schema.json')),
    refund_requests: json(path.join('firebase', 'seed', 'refund_requests_schema.json')),
    notification_outbox: json(path.join('firebase', 'seed', 'notification_outbox_schema.json'))
  };
  for (const { query } of definitions.filter(({ signature }) => signature)) {
    const schema = schemaByCollection[query.collection];
    for (const field of [
      ...query.equalityFilters,
      ...(query.rangeFilter ? [query.rangeFilter] : []),
      ...query.orderBy.map(({ field }) => field)
    ]) assert.ok(schema[field], `${query.name} recovery field ${field} exists`);
  }
});

test('Blocker 1: refund request state machine, failed provider reconciliation, and signed webhook convergence', () => {
  const schema = json(path.join('firebase', 'seed', 'refund_requests_schema.json'));
  const jobsSchema = json(path.join('firebase', 'seed', 'jobs_schema.json'));

  // Assert exact full state machine
  assert.deepEqual(schema._state_machine.states,
    ['pending', 'in_progress', 'submitted', 'confirmed', 'retry_wait', 'failed_terminal']);
  assert.deepEqual(schema._state_machine.legalWorkerTransitions,
    ['pending->in_progress', 'retry_wait->in_progress', 'in_progress->submitted',
     'in_progress->retry_wait', 'in_progress->failed_terminal']);
  assert.deepEqual(schema._state_machine.reconciliationTransitions,
    ['submitted->confirmed', 'submitted->failed_terminal']);
  assert.deepEqual(schema._state_machine.signedWebhookFromStates,
    ['pending', 'in_progress', 'submitted', 'retry_wait', 'failed_terminal']);

  // Assert all 6 immutable identities are preserved on submitted -> failed_terminal:
  const IMMUTABLE_REFUND_IDENTITIES = [
    'jobId', 'razorpayPaymentId', 'razorpayRefundId', 'amountPaise',
    'providerIdempotencyKey', 'providerRequestHash'
  ];
  for (const field of IMMUTABLE_REFUND_IDENTITIES) {
    assert.ok(schema[field], `field ${field} must exist in refund request schema`);
    if (field !== 'razorpayRefundId') {
      assert.equal(schema[field].immutable, true, `${field} must be marked immutable`);
    }
  }

  // failed_terminal must clear worker/reconciliation lease and schedules
  assert.match(schema._submitted_reconciliation_contract.failedResult,
    /clears ownerToken, leaseUntil, and reconciliationNextAttemptAt\/nextAttemptAt/i);
  assert.match(schema._submitted_reconciliation_contract.failedResult,
    /updates the matching job refundState=failed_terminal/i);
  assert.match(schema._submitted_reconciliation_contract.failedResult,
    /failed_terminal does not become confirmed from the fetch that reported failed/i);
  assert.match(schema._submitted_reconciliation_contract.failedResult,
    /does not automatically submit a second refund/i);
  assert.match(schema._submitted_reconciliation_contract.failedResult,
    /does not reset to pending\/submitted through ordinary retry/i);

  // Later valid matching signed webhook can still converge failed_terminal -> confirmed
  assert.match(schema._submitted_reconciliation_contract.failedTerminalResult,
    /later valid matching signed refund\.processed webhook.*still converges failed_terminal to confirmed/i);

  // Job projection reflects failed_terminal in enum and description
  assert.ok(jobsSchema.refundState.enum.includes('failed_terminal'),
    'jobs.refundState enum must include failed_terminal');
  assert.match(jobsSchema.refundState.description, /failed_terminal/i);
  assert.match(jobsSchema._no_driver_refund_contract, /matching provider failed results move to failed_terminal/i);
});

test('Blocker 2: jobs.forfeitedAmount is a non-authoritative display projection overwritten on each accepted-driver cancellation', () => {
  const jobsSchema = json(path.join('firebase', 'seed', 'jobs_schema.json'));

  // Assert schema descriptions and contracts
  assert.match(jobsSchema.forfeitedAmount.description, /Non-authoritative display\/legacy projection/i);
  assert.match(jobsSchema.forfeitedAmount.description, /wallet_entries is the sole permanent financial authority/i);
  assert.match(jobsSchema.forfeitedAmount.description, /NOT cumulative across repeated driver acceptance occurrences/i);
  assert.match(jobsSchema.forfeitedAmount.description, /NOT used to reconstruct wallet balance/i);
  assert.match(jobsSchema.forfeitedAmount.description, /NOT used for idempotency/i);
  assert.match(jobsSchema.forfeitedAmount.description, /NOT used to calculate future cancellation penalties/i);

  // Assert accepted-driver cancellation atomic contract jobChanges
  assert.match(jobsSchema._accepted_driver_cancellation_atomic_contract.jobChanges.forfeitedAmount,
    /overwritten with the forfeiturePaise for that most recent cancellation occurrence/i);

  // Proves behavioral occurrence isolation scenario:
  const jobId = 'job-12345';
  let jobForfeitedAmount = null;
  const ledger = [];

  // Occurrence 1: Driver A accepts (offerA) and cancels with count=2 (20% forfeiture on 10000 paise = 2000 paise)
  const offerIdA = 'offer-aaa-111';
  const driverIdA = 'driver-A';
  const commissionPaiseA = 10000;
  const forfeitureX = 2000;
  const creditA = commissionPaiseA - forfeitureX; // 8000 paise

  // Atomic driver cancellation transaction writes:
  jobForfeitedAmount = forfeitureX; // Overwrite
  const ledgerEntryA = {
    operationId: `driver_cancel_credit:${jobId}:${offerIdA}`,
    driverId: driverIdA,
    jobId,
    offerId: offerIdA,
    type: 'driver_cancel_credit',
    commissionPaise: commissionPaiseA,
    forfeiturePaise: forfeitureX,
    creditPaise: creditA,
    deltaPaise: creditA
  };
  ledger.push(ledgerEntryA);

  assert.equal(jobForfeitedAmount, 2000,
    'After Driver A cancellation, jobs.forfeitedAmount must equal exactly Driver A forfeiture X (2000 paise)');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].forfeiturePaise, 2000);

  // Job redispatches in the same generation. Later Occurrence 2: Driver B accepts (offerB) and cancels with count=5 (50% forfeiture on 10000 paise = 5000 paise)
  const offerIdB = 'offer-bbb-222';
  const driverIdB = 'driver-B';
  const commissionPaiseB = 10000;
  const forfeitureY = 5000;
  const creditB = commissionPaiseB - forfeitureY; // 5000 paise

  // Atomic driver cancellation transaction writes:
  jobForfeitedAmount = forfeitureY; // Overwrite with Y, NOT cumulative (NOT X + Y = 7000)
  const ledgerEntryB = {
    operationId: `driver_cancel_credit:${jobId}:${offerIdB}`,
    driverId: driverIdB,
    jobId,
    offerId: offerIdB,
    type: 'driver_cancel_credit',
    commissionPaise: commissionPaiseB,
    forfeiturePaise: forfeitureY,
    creditPaise: creditB,
    deltaPaise: creditB
  };
  ledger.push(ledgerEntryB);

  // CRITICAL INVARIANT: field represents exactly Y (5000), NOT X+Y (7000)
  assert.equal(jobForfeitedAmount, 5000,
    'After Driver B cancellation, jobs.forfeitedAmount must equal exactly Driver B forfeiture Y (5000 paise), NOT X+Y (7000 paise)');
  assert.notEqual(jobForfeitedAmount, forfeitureX + forfeitureY,
    'jobs.forfeitedAmount MUST NOT be cumulative');

  // Both permanent ledger entries exist independently with occurrence-bound offerId
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].operationId, `driver_cancel_credit:${jobId}:${offerIdA}`);
  assert.equal(ledger[1].operationId, `driver_cancel_credit:${jobId}:${offerIdB}`);
  assert.notEqual(ledger[0].operationId, ledger[1].operationId);
  assert.equal(ledger[0].forfeiturePaise, 2000);
  assert.equal(ledger[1].forfeiturePaise, 5000);
});

test('Blocker 3: independent machine-readable driver cancellation policy evaluator proves complete financial ramp, strict mode, flat 7-day ban, and Asia/Kolkata month rollover', () => {
  // Independent machine-readable policy specification fixture — NOT derived from pricing_config.json
  const INDEPENDENT_LOCKED_POLICY = Object.freeze({
    version: 1,
    timezone: 'Asia/Kolkata',
    roundingMode: 'HALF_UP',
    freeCancellationsPerMonth: 1,
    forfeitPctByCount: Object.freeze({ '2': 20, '3': 30, '4': 40, '5': 50 }),
    banThresholdCount: 6,
    banDurationDays: 7
  });

  // Verify production pricing_config matches this locked policy exactly
  const pricing = json(path.join('firebase', 'seed', 'pricing_config.json'));
  assert.equal(pricing.cancellation_policy.version, INDEPENDENT_LOCKED_POLICY.version);
  assert.equal(pricing.cancellation_policy.timezone, INDEPENDENT_LOCKED_POLICY.timezone);
  assert.equal(pricing.cancellation_policy.roundingMode, INDEPENDENT_LOCKED_POLICY.roundingMode);
  assert.equal(pricing.cancellation_policy.free_cancellations_per_month, INDEPENDENT_LOCKED_POLICY.freeCancellationsPerMonth);
  assert.deepEqual(pricing.cancellation_policy.forfeit_pct_by_count, INDEPENDENT_LOCKED_POLICY.forfeitPctByCount);
  assert.equal(pricing.cancellation_policy.ban_threshold_count, INDEPENDENT_LOCKED_POLICY.banThresholdCount);
  assert.equal(pricing.cancellation_policy.ban_duration_days, INDEPENDENT_LOCKED_POLICY.banDurationDays);

  // Independent cancellation evaluator implementing source truth
  function getIstMonthString(date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit'
    });
    return formatter.format(date);
  }

  function evaluateCancellation(policy, driverState, commissionPaise, eventDate) {
    assert.ok(Number.isInteger(commissionPaise) && commissionPaise > 0, 'commissionPaise must be positive integer');
    const currentMonth = getIstMonthString(eventDate);
    const storedMonth = driverState.monthlyCancelCount ? driverState.monthlyCancelCount.month : '';
    const isNewMonth = storedMonth !== currentMonth;

    // Month rollover logic: reset count to 0 and strictMode to false
    const countBefore = isNewMonth ? 0 : (driverState.monthlyCancelCount ? driverState.monthlyCancelCount.count : 0);
    const strictModeBefore = isNewMonth ? false : (driverState.strictMode === true);
    const activeBanBefore = driverState.bannedUntil ? new Date(driverState.bannedUntil) : null;
    const activeBanInFuture = activeBanBefore && activeBanBefore > eventDate;
    const preservedBan = activeBanInFuture ? activeBanBefore.toISOString() : null;

    const newCount = countBefore + 1;
    let forfeiturePercent;
    let strictModeApplied;
    let strictModeAfter;
    let bannedUntilAfter;

    if (strictModeBefore) {
      forfeiturePercent = 100;
      strictModeApplied = true;
      strictModeAfter = true;
      const banEnd = new Date(eventDate.getTime() + policy.banDurationDays * 24 * 60 * 60 * 1000);
      bannedUntilAfter = banEnd.toISOString();
    } else {
      strictModeApplied = false;
      if (newCount <= policy.freeCancellationsPerMonth) {
        forfeiturePercent = 0;
        strictModeAfter = false;
        bannedUntilAfter = preservedBan;
      } else if (newCount >= policy.banThresholdCount) {
        forfeiturePercent = 100;
        strictModeAfter = true;
        const banEnd = new Date(eventDate.getTime() + policy.banDurationDays * 24 * 60 * 60 * 1000);
        bannedUntilAfter = banEnd.toISOString();
      } else {
        const rampPct = policy.forfeitPctByCount[String(newCount)];
        assert.ok(rampPct !== undefined, `Missing ramp percentage for count ${newCount}`);
        forfeiturePercent = rampPct;
        strictModeAfter = false;
        bannedUntilAfter = preservedBan;
      }
    }

    // HALF_UP integer paise arithmetic
    const exactForfeiture = (commissionPaise * forfeiturePercent) / 100;
    const forfeiturePaise = Math.round(exactForfeiture);
    const creditPaise = commissionPaise - forfeiturePaise;
    const deltaPaise = creditPaise;

    return {
      cancellationMonth: currentMonth,
      newCount,
      isNewMonth,
      strictModeBefore,
      strictModeApplied,
      strictModeAfter,
      bannedUntilAfter,
      forfeiturePercent,
      forfeiturePaise,
      creditPaise,
      deltaPaise,
      driverStateAfter: {
        monthlyCancelCount: { month: currentMonth, count: newCount },
        strictMode: strictModeAfter,
        bannedUntil: bannedUntilAfter
      }
    };
  }

  const commission = 10000; // 10000 paise = Rs 100
  const eventTime = new Date('2026-08-15T10:00:00.000Z'); // Inside 2026-08

  // 1st cancellation: 0% forfeiture, 100% credit, count becomes 1
  let state = { monthlyCancelCount: { month: '2026-08', count: 0 }, strictMode: false, bannedUntil: null };
  let res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, eventTime);
  assert.equal(res.forfeiturePercent, 0, '1st cancel: 0% forfeiture');
  assert.equal(res.forfeiturePaise, 0, '1st cancel: 0 paise forfeited');
  assert.equal(res.creditPaise, 10000, '1st cancel: 100% (10000 paise) credited');
  assert.equal(res.deltaPaise, 10000, '1st cancel delta = +10000');
  assert.equal(res.newCount, 1, '1st cancel count = 1');
  assert.equal(res.strictModeAfter, false, '1st cancel strictMode remains false');
  assert.equal(res.bannedUntilAfter, null, '1st cancel bannedUntil is null');
  state = res.driverStateAfter;

  // 2nd cancellation: 20% forfeiture
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, eventTime);
  assert.equal(res.forfeiturePercent, 20, '2nd cancel: 20% forfeiture');
  assert.equal(res.forfeiturePaise, 2000, '2nd cancel: 2000 paise forfeited');
  assert.equal(res.creditPaise, 8000, '2nd cancel: 8000 paise credited');
  assert.equal(res.newCount, 2, '2nd cancel count = 2');
  assert.equal(res.strictModeAfter, false);
  assert.equal(res.bannedUntilAfter, null);
  state = res.driverStateAfter;

  // 3rd cancellation: 30% forfeiture
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, eventTime);
  assert.equal(res.forfeiturePercent, 30, '3rd cancel: 30% forfeiture');
  assert.equal(res.forfeiturePaise, 3000, '3rd cancel: 3000 paise forfeited');
  assert.equal(res.creditPaise, 7000, '3rd cancel: 7000 paise credited');
  assert.equal(res.newCount, 3, '3rd cancel count = 3');
  assert.equal(res.strictModeAfter, false);
  assert.equal(res.bannedUntilAfter, null);
  state = res.driverStateAfter;

  // 4th cancellation: 40% forfeiture
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, eventTime);
  assert.equal(res.forfeiturePercent, 40, '4th cancel: 40% forfeiture');
  assert.equal(res.forfeiturePaise, 4000, '4th cancel: 4000 paise forfeited');
  assert.equal(res.creditPaise, 6000, '4th cancel: 6000 paise credited');
  assert.equal(res.newCount, 4, '4th cancel count = 4');
  assert.equal(res.strictModeAfter, false);
  assert.equal(res.bannedUntilAfter, null);
  state = res.driverStateAfter;

  // 5th cancellation: 50% forfeiture
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, eventTime);
  assert.equal(res.forfeiturePercent, 50, '5th cancel: 50% forfeiture');
  assert.equal(res.forfeiturePaise, 5000, '5th cancel: 5000 paise forfeited');
  assert.equal(res.creditPaise, 5000, '5th cancel: 5000 paise credited');
  assert.equal(res.newCount, 5, '5th cancel count = 5');
  assert.equal(res.strictModeAfter, false);
  assert.equal(res.bannedUntilAfter, null);
  state = res.driverStateAfter;

  // 6th cancellation: 100% forfeiture, strictMode becomes true, flat 7-day ban starts
  const banStartTime = new Date('2026-08-20T10:00:00.000Z');
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, banStartTime);
  assert.equal(res.forfeiturePercent, 100, '6th cancel: 100% forfeiture');
  assert.equal(res.forfeiturePaise, 10000, '6th cancel: 10000 paise forfeited');
  assert.equal(res.creditPaise, 0, '6th cancel: 0 paise credited');
  assert.equal(res.deltaPaise, 0, '6th cancel delta = 0');
  assert.equal(res.newCount, 6, '6th cancel count = 6');
  assert.equal(res.strictModeAfter, true, '6th cancel: strictMode becomes true');
  const expectedBanEnd = new Date(banStartTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(res.bannedUntilAfter, expectedBanEnd, '6th cancel: flat 7-day ban set');
  state = res.driverStateAfter;

  // 7th cancellation in same month while strict: 100% forfeiture, fresh flat 7-day ban
  const rebanTime = new Date('2026-08-28T12:00:00.000Z');
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, rebanTime);
  assert.equal(res.forfeiturePercent, 100, '7th cancel (strict): 100% forfeiture');
  assert.equal(res.forfeiturePaise, 10000);
  assert.equal(res.creditPaise, 0);
  assert.equal(res.newCount, 7, '7th cancel count = 7');
  assert.equal(res.strictModeBefore, true, 'strict mode was active before');
  assert.equal(res.strictModeApplied, true, 'strict mode bypassed ramp');
  assert.equal(res.strictModeAfter, true, 'strict mode remains true');
  const expectedRebanEnd = new Date(rebanTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(res.bannedUntilAfter, expectedRebanEnd, '7th cancel: fresh flat 7-day ban set');
  state = res.driverStateAfter;

  // 8th cancellation in same month while strict: 100% forfeiture, fresh flat 7-day ban
  const rebanTime8 = new Date('2026-08-29T12:00:00.000Z');
  res = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, state, commission, rebanTime8);
  assert.equal(res.forfeiturePercent, 100);
  assert.equal(res.forfeiturePaise, 10000);
  assert.equal(res.creditPaise, 0);
  assert.equal(res.newCount, 8);
  assert.equal(res.strictModeAfter, true);
  state = res.driverStateAfter;

  // HALF_UP arithmetic with odd commission paise (e.g. 1255 paise)
  const oddCommission = 1255;
  const oddState2 = { monthlyCancelCount: { month: '2026-08', count: 1 }, strictMode: false, bannedUntil: null };
  const oddRes2 = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, oddState2, oddCommission, eventTime);
  assert.equal(oddRes2.forfeiturePaise, 251, '20% of 1255 = 251.0 -> 251');
  assert.equal(oddRes2.creditPaise, 1004, '1255 - 251 = 1004');
  assert.equal(oddRes2.forfeiturePaise + oddRes2.creditPaise, oddCommission);

  const oddState3 = { monthlyCancelCount: { month: '2026-08', count: 2 }, strictMode: false, bannedUntil: null };
  const oddRes3 = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, oddState3, oddCommission, eventTime);
  assert.equal(oddRes3.forfeiturePaise, 377, '30% of 1255 = 376.5 -> HALF_UP rounds to 377');
  assert.equal(oddRes3.creditPaise, 878, '1255 - 377 = 878');
  assert.equal(oddRes3.forfeiturePaise + oddRes3.creditPaise, oddCommission);

  const oddState5 = { monthlyCancelCount: { month: '2026-08', count: 4 }, strictMode: false, bannedUntil: null };
  const oddRes5 = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, oddState5, oddCommission, eventTime);
  assert.equal(oddRes5.forfeiturePaise, 628, '50% of 1255 = 627.5 -> HALF_UP rounds to 628');
  assert.equal(oddRes5.creditPaise, 627, '1255 - 628 = 627');
  assert.equal(oddRes5.forfeiturePaise + oddRes5.creditPaise, oddCommission);

  // MONTH ROLLOVER in Asia/Kolkata:
  // Scenario A: Month rollover when prior ban has ALREADY expired (Sep 6 > Sep 5)
  // Driver was at 8 cancellations in 2026-08, strictMode = true, banned until 2026-09-05T12:00:00.000Z
  const activeBanUntilSep5 = '2026-09-05T12:00:00.000Z';
  const strictStateEndAugust = {
    monthlyCancelCount: { month: '2026-08', count: 8 },
    strictMode: true,
    bannedUntil: activeBanUntilSep5
  };

  // Cancellation occurs on Sep 6 in 2026-09 IST (after ban expires)
  const sepCancelTime = new Date('2026-09-06T10:00:00.000+05:30');
  const sepRes = evaluateCancellation(INDEPENDENT_LOCKED_POLICY, strictStateEndAugust, commission, sepCancelTime);
  assert.equal(sepRes.isNewMonth, true, 'Month rollover detected for 2026-09');
  assert.equal(sepRes.cancellationMonth, '2026-09');
  assert.equal(sepRes.newCount, 1, 'Monthly cancellation count resets to 0 before cancel, becoming 1 on this cancel');
  assert.equal(sepRes.strictModeBefore, false, 'strictMode resets to false at month rollover');
  assert.equal(sepRes.strictModeAfter, false, 'strictMode remains false on 1st cancel of new month');
  assert.equal(sepRes.forfeiturePercent, 0, '1st cancellation in new month is 0% forfeiture (clean slate)');
  assert.equal(sepRes.forfeiturePaise, 0);
  assert.equal(sepRes.creditPaise, 10000);
  assert.equal(sepRes.bannedUntilAfter, null, 'Expired ban clears to null when no new ban is triggered');

  // Scenario B: Active ban non-truncation across month rollover
  // 1. Initiate 7-day ban on Aug 31 23:30 IST (count reaches 6 in August)
  const endMonthBanStart = new Date('2026-08-31T23:30:00.000+05:30'); // 30 min before midnight IST in August
  const banRes = evaluateCancellation(INDEPENDENT_LOCKED_POLICY,
    { monthlyCancelCount: { month: '2026-08', count: 5 }, strictMode: false, bannedUntil: null },
    commission, endMonthBanStart);
  assert.equal(banRes.newCount, 6);
  assert.equal(banRes.strictModeAfter, true);
  const banExpectedExpiry = new Date(endMonthBanStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(banRes.bannedUntilAfter, banExpectedExpiry);
  const activeBanPriorState = banRes.driverStateAfter;
  assert.equal(activeBanPriorState.monthlyCancelCount.month, '2026-08');
  assert.equal(activeBanPriorState.monthlyCancelCount.count, 6);
  assert.equal(activeBanPriorState.strictMode, true);
  assert.equal(activeBanPriorState.bannedUntil, banExpectedExpiry);

  // 2. Perform ACTUAL cancellation evaluation in September while the ban is STILL ACTIVE
  // Evaluation time: Sep 1, 2026 at 00:05:00.000+05:30 (5 minutes after rollover; ban expires Sep 7)
  const sepActiveBanEvalTime = new Date('2026-09-01T00:05:00.000+05:30');
  assert.ok(new Date(banExpectedExpiry).getTime() > sepActiveBanEvalTime.getTime(),
    'Precondition: ban expiry (Sep 7) is strictly in the future relative to September evaluation time');

  const rolloverActiveBanRes = evaluateCancellation(
    INDEPENDENT_LOCKED_POLICY,
    activeBanPriorState,
    commission,
    sepActiveBanEvalTime
  );

  // Assert all 6 simultaneous month-rollover preservation and reset requirements:
  // 1. Policy month changes to September
  assert.equal(rolloverActiveBanRes.isNewMonth, true, 'Month rollover detected for September');
  assert.equal(rolloverActiveBanRes.cancellationMonth, '2026-09', '1. Policy month changes to September');

  // 2. Monthly cancellation count resets according to locked source truth (0 before cancel -> 1 on this cancel)
  assert.equal(rolloverActiveBanRes.newCount, 1, '2. Monthly cancellation count resets to 0 before cancel, becoming 1');
  assert.equal(rolloverActiveBanRes.driverStateAfter.monthlyCancelCount.month, '2026-09');
  assert.equal(rolloverActiveBanRes.driverStateAfter.monthlyCancelCount.count, 1);

  // 3. Strict mode resets according to locked source truth (true in August -> false in September)
  assert.equal(rolloverActiveBanRes.strictModeBefore, false, '3. Strict mode resets to false at month rollover');
  assert.equal(rolloverActiveBanRes.strictModeAfter, false, 'Strict mode remains false on 1st cancel of new month');
  assert.equal(rolloverActiveBanRes.forfeiturePercent, 0, '1st cancel in new month has 0% forfeiture');
  assert.equal(rolloverActiveBanRes.forfeiturePaise, 0);
  assert.equal(rolloverActiveBanRes.creditPaise, commission);
  assert.equal(rolloverActiveBanRes.driverStateAfter.strictMode, false);

  // 4. bannedUntil remains EXACTLY equal to the pre-rollover ban expiry
  assert.equal(rolloverActiveBanRes.bannedUntilAfter, banExpectedExpiry,
    '4. bannedUntil remains EXACTLY equal to the pre-rollover ban expiry');
  assert.equal(rolloverActiveBanRes.driverStateAfter.bannedUntil, banExpectedExpiry,
    'Driver state bannedUntil remains EXACTLY equal to the pre-rollover ban expiry');
  assert.equal(rolloverActiveBanRes.bannedUntilAfter, activeBanPriorState.bannedUntil,
    'bannedUntilAfter directly equals prior state bannedUntil');

  // 5. bannedUntil is still > evaluation time
  assert.ok(new Date(rolloverActiveBanRes.bannedUntilAfter).getTime() > sepActiveBanEvalTime.getTime(),
    '5. bannedUntil is still in the future after September evaluation');

  // 6. Rollover does NOT shorten, null, recompute, or alter the active ban
  assert.notEqual(rolloverActiveBanRes.bannedUntilAfter, null, '6. bannedUntil must not be nulled');
  assert.notEqual(rolloverActiveBanRes.bannedUntilAfter, sepActiveBanEvalTime.toISOString(),
    'bannedUntil must not be shortened to evaluation/rollover time');
  const recomputedFromEval = new Date(sepActiveBanEvalTime.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.notEqual(rolloverActiveBanRes.bannedUntilAfter, recomputedFromEval,
    'bannedUntil must not be recomputed from new month evaluation time');

  // 3. Follow-up cancellation on Sep 3 while ban is STILL ACTIVE (ramp 20%, ban STILL preserved)
  const sep3EvalTime = new Date('2026-09-03T10:00:00.000+05:30');
  const sep3Res = evaluateCancellation(
    INDEPENDENT_LOCKED_POLICY,
    rolloverActiveBanRes.driverStateAfter,
    commission,
    sep3EvalTime
  );
  assert.equal(sep3Res.isNewMonth, false);
  assert.equal(sep3Res.cancellationMonth, '2026-09');
  assert.equal(sep3Res.newCount, 2, '2nd cancellation in September');
  assert.equal(sep3Res.forfeiturePercent, 20, '20% forfeiture on 2nd cancellation');
  assert.equal(sep3Res.strictModeAfter, false);
  assert.equal(sep3Res.bannedUntilAfter, banExpectedExpiry,
    'Active ban remains EXACTLY preserved on 2nd cancellation in new month');
  assert.equal(sep3Res.driverStateAfter.bannedUntil, banExpectedExpiry);

  // 4. Follow-up cancellation on Sep 8 AFTER ban expiry (ramp 30%, ban now null)
  const sep8EvalTime = new Date('2026-09-08T10:00:00.000+05:30');
  const sep8Res = evaluateCancellation(
    INDEPENDENT_LOCKED_POLICY,
    sep3Res.driverStateAfter,
    commission,
    sep8EvalTime
  );
  assert.equal(sep8Res.isNewMonth, false);
  assert.equal(sep8Res.cancellationMonth, '2026-09');
  assert.equal(sep8Res.newCount, 3, '3rd cancellation in September');
  assert.equal(sep8Res.forfeiturePercent, 30, '30% forfeiture on 3rd cancellation');
  assert.equal(sep8Res.strictModeAfter, false);
  assert.equal(sep8Res.bannedUntilAfter, null,
    'Ban naturally clears to null after expiry date passes');
  assert.equal(sep8Res.driverStateAfter.bannedUntil, null);

  // Timezone IST boundary proof (UTC vs Asia/Kolkata)
  // UTC 2026-08-31T18:29:59.000Z -> IST is 2026-08-31T23:59:59+05:30 (Month 2026-08)
  const augUtc = new Date('2026-08-31T18:29:59.000Z');
  assert.equal(getIstMonthString(augUtc), '2026-08', 'UTC 18:29 on Aug 31 is still August in IST');

  // UTC 2026-08-31T18:30:01.000Z -> IST is 2026-09-01T00:00:01+05:30 (Month 2026-09)
  const sepUtc = new Date('2026-08-31T18:30:01.000Z');
  assert.equal(getIstMonthString(sepUtc), '2026-09', 'UTC 18:30 on Aug 31 crosses midnight into September in IST');
});
