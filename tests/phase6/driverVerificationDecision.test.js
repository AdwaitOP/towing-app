'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const {
  FakeFirestore,
  FakeAuth,
  FakeStorage,
} = require('./fakeAdminDeps');

const {
  createDecisionManager,
  isExactTimestamp,
  isValidDriverUid,
  isValidGeneration,
  validateNormalizedReason,
  computeReceiptDocId,
  computePayloadHash,
} = require('../../firebase/functions/src/admin/driverVerificationDecision');

const BUCKET_NAME = 'demo-towmitra-admin.appspot.com';
const ADMIN_UID = 'admin-uid-1';
const VALID_TOKEN = 'token-admin-1';
const VALID_REQUEST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const DRIVER_UID = 'drv-test-1';

function makeValidTimestamps() {
  const updatedTs = new Timestamp(1729300000, 123456789);
  const submittedTs = new Timestamp(1729290000, 987654321);
  return {
    updatedTs,
    submittedTs,
    expectedUpdatedAt: { seconds: updatedTs.seconds, nanoseconds: updatedTs.nanoseconds },
    expectedSubmittedAt: { seconds: submittedTs.seconds, nanoseconds: submittedTs.nanoseconds },
  };
}

function makeValidDriverData({
  updatedTs,
  submittedTs,
  status = 'pending',
  truckType = 'flatbed',
  name = 'Ramesh Patil',
  vehicleNumber = 'MH04AB1234',
  phone = '+919876543210',
  isOnDuty = false,
  rejectionReason = null,
  activeJobId = null,
  activeOfferId = null,
  dutySessionId = null,
  workerReady = false,
  canFlatbed = undefined,
  canPulling = undefined,
} = {}) {
  const d = {
    uid: DRIVER_UID,
    name,
    vehicleNumber,
    phone,
    truckType,
    isOnDuty,
    verificationStatus: status,
    createdAt: new Timestamp(1729000000, 0),
    updatedAt: updatedTs,
    verificationDocs: {
      idPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${DRIVER_UID}/id.jpg`,
      rcPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${DRIVER_UID}/rc.jpg`,
      selfiePhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${DRIVER_UID}/selfie.jpg`,
      submittedAt: submittedTs,
    },
    rejectionReason,
    activeJobId,
    activeOfferId,
    dutySessionId,
    workerReady,
  };
  if (canFlatbed !== undefined) d.canFlatbed = canFlatbed;
  if (canPulling !== undefined) d.canPulling = canPulling;
  return d;
}

function makeValidStorageFiles(generations = { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' }) {
  return {
    [`driver_verification/${DRIVER_UID}/id.jpg`]: {
      name: `driver_verification/${DRIVER_UID}/id.jpg`,
      generation: generations.id,
      contentType: 'image/jpeg',
      size: 1024 * 50,
    },
    [`driver_verification/${DRIVER_UID}/rc.jpg`]: {
      name: `driver_verification/${DRIVER_UID}/rc.jpg`,
      generation: generations.rc,
      contentType: 'image/jpeg',
      size: 1024 * 60,
    },
    [`driver_verification/${DRIVER_UID}/selfie.jpg`]: {
      name: `driver_verification/${DRIVER_UID}/selfie.jpg`,
      generation: generations.selfie,
      contentType: 'image/jpeg',
      size: 1024 * 70,
    },
  };
}

function setupTestEnvironment({
  driverOverrides = {},
  storageGenerations = { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
  userOverrides = {},
  tokenOverrides = {},
} = {}) {
  const { updatedTs, submittedTs, expectedUpdatedAt, expectedSubmittedAt } = makeValidTimestamps();

  const driverData = makeValidDriverData({
    updatedTs,
    submittedTs,
    ...driverOverrides,
  });

  const firestore = new FakeFirestore({
    drivers: {
      [DRIVER_UID]: driverData,
    },
    admin_actions: {},
    processed_requests: {},
  });

  const users = {
    [ADMIN_UID]: {
      uid: ADMIN_UID,
      disabled: false,
      customClaims: { admin: true },
      ...userOverrides,
    },
  };

  const tokens = {
    [VALID_TOKEN]: {
      uid: ADMIN_UID,
      admin: true,
      ...tokenOverrides,
    },
  };

  const auth = new FakeAuth(users, tokens);
  const storage = new FakeStorage(makeValidStorageFiles(storageGenerations), BUCKET_NAME);

  const manager = createDecisionManager({
    db: firestore,
    auth,
    storage,
    TimestampClass: Timestamp,
    FieldValueClass: FieldValue,
  });

  const validRequest = {
    auth: {
      uid: ADMIN_UID,
      token: { admin: true },
    },
    token: VALID_TOKEN,
  };

  return {
    firestore,
    auth,
    storage,
    manager,
    validRequest,
    expectedUpdatedAt,
    expectedSubmittedAt,
    storageGenerations,
  };
}

// ── 1. Helper function unit tests ──────────────────────────────────────────

test('isExactTimestamp: accepts exact seconds & nanoseconds in range', () => {
  assert.equal(isExactTimestamp({ seconds: 1729000000, nanoseconds: 123456789 }), true);
  assert.equal(isExactTimestamp({ seconds: 0, nanoseconds: 0 }), true);
  assert.equal(isExactTimestamp({ seconds: 253402300799, nanoseconds: 999999999 }), true);

  // Rejections
  assert.equal(isExactTimestamp(null), false);
  assert.equal(isExactTimestamp({}), false);
  assert.equal(isExactTimestamp({ seconds: 1 }), false);
  assert.equal(isExactTimestamp({ seconds: 1, nanoseconds: 0, extra: true }), false);
  assert.equal(isExactTimestamp({ seconds: 1.5, nanoseconds: 0 }), false);
  assert.equal(isExactTimestamp({ seconds: 1, nanoseconds: 1000000000 }), false);
  assert.equal(isExactTimestamp({ seconds: -70000000000, nanoseconds: 0 }), false);
  assert.equal(isExactTimestamp({ seconds: '1729000000', nanoseconds: 0 }), false);
});

test('isValidDriverUid: validates string length, no slashes, no whitespace', () => {
  assert.equal(isValidDriverUid('driver-123_abc'), true);
  assert.equal(isValidDriverUid(''), false);
  assert.equal(isValidDriverUid('   '), false);
  assert.equal(isValidDriverUid('driver/123'), false);
  assert.equal(isValidDriverUid('driver 123'), false);
  assert.equal(isValidDriverUid('driver\x00123'), false);
});

test('isValidGeneration: validates bounded opaque generation string', () => {
  assert.equal(isValidGeneration('1729278912345678'), true);
  assert.equal(isValidGeneration('gen-abc_123.~+'), true);
  assert.equal(isValidGeneration(''), false);
  assert.equal(isValidGeneration('gen/123'), false);
  assert.equal(isValidGeneration('gen 123'), false);
  assert.equal(isValidGeneration('a'.repeat(129)), false);
});

test('validateNormalizedReason: enforces length 10..500 code points, NFC, no control chars', () => {
  const validReason = '  Vehicle RC is blurred and not readable  ';
  const norm = validateNormalizedReason(validReason);
  assert.equal(norm, 'Vehicle RC is blurred and not readable');

  // Short (< 10)
  assert.throws(() => validateNormalizedReason('Too short'), { code: 'invalid-argument' });
  // Long (> 500)
  assert.throws(() => validateNormalizedReason('A'.repeat(501)), { code: 'invalid-argument' });
  // Control char
  assert.throws(() => validateNormalizedReason('Valid reason with \x00 null byte'), { code: 'invalid-argument' });
  assert.throws(() => validateNormalizedReason('Valid reason with \x1F control'), { code: 'invalid-argument' });
});

test('deterministic receipt doc ID and payload hash are stable', () => {
  const id1 = computeReceiptDocId('admin1', 'req1');
  const id2 = computeReceiptDocId('admin1', 'req1');
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('m2_verify_'));

  const p1 = computePayloadHash({
    operation: 'adminApproveDriver',
    driverUid: 'drv1',
    expectedUpdatedAt: { seconds: 10, nanoseconds: 20 },
    expectedSubmittedAt: { seconds: 30, nanoseconds: 40 },
    decisionValues: [true, false, 'g1', 'g2', 'g3'],
  });
  const p2 = computePayloadHash({
    operation: 'adminApproveDriver',
    driverUid: 'drv1',
    expectedUpdatedAt: { seconds: 10, nanoseconds: 20 },
    expectedSubmittedAt: { seconds: 30, nanoseconds: 40 },
    decisionValues: [true, false, 'g1', 'g2', 'g3'],
  });
  assert.equal(p1, p2);
});

// ── 2. Authorization and Security Gates (S01, S02) ─────────────────────────

test('S01: anonymous caller fails with unauthenticated', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: null,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'unauthenticated' }
  );
});

test('S01: non-admin claim (false, string, number, null) fails with permission-denied', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  const invalidClaims = [false, 'true', 1, null, undefined];

  for (const claim of invalidClaims) {
    await assert.rejects(
      async () => {
        await manager.executeDecision({
          operation: 'adminApproveDriver',
          request: {
            auth: { uid: ADMIN_UID, token: { admin: claim } },
            token: VALID_TOKEN,
            data: {
              requestId: VALID_REQUEST_ID,
              driverUid: DRIVER_UID,
              expectedUpdatedAt,
              expectedSubmittedAt,
              canFlatbed: true,
              canPulling: false,
              expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
            },
          },
        });
      },
      { code: 'permission-denied' }
    );
  }
});

test('S01: missing bearer token in request fails with unauthenticated', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          // No token or rawRequest
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'unauthenticated' }
  );
});

test('S01: Bearer owner credential fails with permission-denied', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: 'owner',
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'permission-denied' }
  );
});

test('S01: revoked token fails with unauthenticated', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    tokenOverrides: { revoked: true },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: VALID_TOKEN,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'unauthenticated' }
  );
});

test('S02: demoted admin (customClaims.admin !== true) fails with permission-denied', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    userOverrides: { customClaims: { admin: false } },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: VALID_TOKEN,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'permission-denied' }
  );
});

test('S02: disabled admin account fails with permission-denied', async () => {
  const { manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    userOverrides: { disabled: true },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: VALID_TOKEN,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'permission-denied' }
  );
});

test('S02: authority outage (503 / auth/internal-error) fails with unavailable', async () => {
  const { auth, manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  auth.verifyIdToken = async () => {
    const err = new Error('Error while making request: status 503');
    err.code = 'auth/internal-error';
    throw err;
  };

  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: VALID_TOKEN,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'unavailable' }
  );
});

test('S02: transaction retry authority outage fails with unavailable', async () => {
  const { auth, manager, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  let calls = 0;
  const originalVerify = auth.verifyIdToken.bind(auth);
  auth.verifyIdToken = async (tok, check) => {
    calls++;
    if (calls > 1) {
      const err = new Error('Auth 503 during retry');
      err.code = 'auth/internal-error';
      throw err;
    }
    return originalVerify(tok, check);
  };

  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          auth: { uid: ADMIN_UID, token: { admin: true } },
          token: VALID_TOKEN,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'unavailable' }
  );
});

// ── 3. Request validation tests ─────────────────────────────────────────────

test('request validation: unexpected keys rejected with invalid-argument', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
            unauthorizedKey: 'malicious',
          },
        },
      });
    },
    { code: 'invalid-argument' }
  );
});

test('request validation: malformed requestId rejected with invalid-argument', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: 'not-a-uuid',
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'invalid-argument' }
  );
});

test('F03: approval with both capabilities false rejected with invalid-argument', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: false,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'invalid-argument' }
  );
});

test('F03: approval with non-boolean capabilities rejected with invalid-argument', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: 'true',
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'invalid-argument' }
  );
});

test('F04: rejection with invalid reason (<10 code points) rejected with invalid-argument', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminRejectDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            reason: 'Short',
          },
        },
      });
    },
    { code: 'invalid-argument' }
  );
});

// ── 4. Driver eligibility & review fence gates (F05, F06) ───────────────────

test('F05: driver profile not found fails with not-found', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: 'drv-nonexistent',
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    { code: 'not-found' }
  );
});

test('F05: non-pending status (already approved) fails with failed-precondition ALREADY_DECIDED', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    driverOverrides: { status: 'approved' },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'ALREADY_DECIDED'
  );
});

test('F06: stale review (updatedAt nanoseconds differ) fails with STALE_APPLICATION', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt: {
              seconds: expectedUpdatedAt.seconds,
              nanoseconds: expectedUpdatedAt.nanoseconds + 1, // 1 nanosecond difference
            },
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'STALE_APPLICATION'
  );
});

test('F05: engaged driver (activeJobId nonnull) fails with DRIVER_ENGAGED', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    driverOverrides: { activeJobId: 'job-123' },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'DRIVER_ENGAGED'
  );
});

test('F05: malformed profile (missing name) fails with APPLICATION_INVALID', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    driverOverrides: { name: '   ' },
  });
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'APPLICATION_INVALID'
  );
});

// ── 5. Storage Evidence Gates (F02) ─────────────────────────────────────────

test('F02: approval with changed evidence generation fails with EVIDENCE_CHANGED', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: {
              id: 'stale-gen',
              rc: 'gen-rc-1',
              selfie: 'gen-selfie-1',
            },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'EVIDENCE_CHANGED'
  );
});

test('F02: approval with missing storage file fails with EVIDENCE_UNAVAILABLE', async () => {
  const { firestore, auth, expectedUpdatedAt, expectedSubmittedAt, validRequest } = setupTestEnvironment();
  // Storage with no files
  const emptyStorage = new FakeStorage({}, BUCKET_NAME);
  const manager = createDecisionManager({
    db: firestore,
    auth,
    storage: emptyStorage,
    TimestampClass: Timestamp,
    FieldValueClass: FieldValue,
  });

  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: false,
            expectedObjectGenerations: { id: 'gen-id-1', rc: 'gen-rc-1', selfie: 'gen-selfie-1' },
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'EVIDENCE_UNAVAILABLE'
  );
});

// ── 6. Successful Decisions, Write Set, Audit & Receipt (F03, F04, S04) ──────

test('F03 & S04: valid pending approval patches exactly 5 fields, creates audit and receipt', async () => {
  const { firestore, manager, validRequest, expectedUpdatedAt, expectedSubmittedAt, storageGenerations } = setupTestEnvironment();

  const result = await manager.executeDecision({
    operation: 'adminApproveDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        canFlatbed: true,
        canPulling: false,
        expectedObjectGenerations: storageGenerations,
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.driverUid, DRIVER_UID);
  assert.equal(result.verificationStatus, 'approved');
  assert.equal(result.replayed, false);
  assert.ok(result.actionId);

  // Verify driver document in firestore
  const driver = firestore.data.drivers[DRIVER_UID];
  assert.equal(driver.verificationStatus, 'approved');
  assert.equal(driver.canFlatbed, true);
  assert.equal(driver.canPulling, false);
  assert.equal(driver.rejectionReason, null);
  assert.ok(driver.updatedAt instanceof Timestamp);
  // Ensure other fields remained untouched
  assert.equal(driver.name, 'Ramesh Patil');
  assert.equal(driver.vehicleNumber, 'MH04AB1234');
  assert.equal(driver.isOnDuty, false);

  // Verify admin_actions record
  const audit = firestore.data.admin_actions[result.actionId];
  assert.ok(audit, 'Audit record must exist in admin_actions');
  assert.equal(audit.adminUid, ADMIN_UID);
  assert.equal(audit.action, 'approve_driver');
  assert.equal(audit.target, DRIVER_UID);
  assert.equal(audit.reason, null);
  assert.equal(audit.metadata.contractVersion, 'M2-ARCH-1');
  assert.equal(audit.metadata.requestId, VALID_REQUEST_ID);
  assert.equal(audit.metadata.oldStatus, 'pending');
  assert.equal(audit.metadata.newStatus, 'approved');
  assert.deepEqual(audit.metadata.newCapabilities, { canFlatbed: true, canPulling: false });
  assert.deepEqual(audit.metadata.objectGenerations, storageGenerations);

  // Verify processed_requests receipt
  const receiptDocId = computeReceiptDocId(ADMIN_UID, VALID_REQUEST_ID);
  const receipt = firestore.data.processed_requests[receiptDocId];
  assert.ok(receipt, 'Receipt record must exist in processed_requests');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.actorUid, ADMIN_UID);
  assert.equal(receipt.operation, 'adminApproveDriver');
  assert.equal(receipt.resourceId, DRIVER_UID);
  assert.equal(receipt.result.actionId, result.actionId);
});

test('F04: valid pending rejection patches exactly 5 fields, capabilities false, reason stored', async () => {
  const { firestore, manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();

  const rejectionReason = 'Uploaded vehicle RC is blurred and not legible for verification.';

  const result = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        reason: `  ${rejectionReason}  `,
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.driverUid, DRIVER_UID);
  assert.equal(result.verificationStatus, 'rejected');
  assert.equal(result.replayed, false);
  assert.ok(result.actionId);

  // Verify driver document
  const driver = firestore.data.drivers[DRIVER_UID];
  assert.equal(driver.verificationStatus, 'rejected');
  assert.equal(driver.canFlatbed, false);
  assert.equal(driver.canPulling, false);
  assert.equal(driver.rejectionReason, rejectionReason);
  assert.ok(driver.updatedAt instanceof Timestamp);

  // Verify audit
  const audit = firestore.data.admin_actions[result.actionId];
  assert.equal(audit.adminUid, ADMIN_UID);
  assert.equal(audit.action, 'reject_driver');
  assert.equal(audit.reason, rejectionReason);
  assert.equal(audit.metadata.newStatus, 'rejected');
  assert.deepEqual(audit.metadata.newCapabilities, { canFlatbed: false, canPulling: false });
  assert.equal(audit.metadata.objectGenerations, null);
});

test('F05: rejection with missing physical storage files succeeds when profile and envelope are valid', async () => {
  const { firestore, auth, expectedUpdatedAt, expectedSubmittedAt, validRequest } = setupTestEnvironment();
  // Empty storage
  const emptyStorage = new FakeStorage({}, BUCKET_NAME);
  const manager = createDecisionManager({
    db: firestore,
    auth,
    storage: emptyStorage,
    TimestampClass: Timestamp,
    FieldValueClass: FieldValue,
  });

  const result = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        reason: 'Missing documents in verification evidence bucket.',
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.verificationStatus, 'rejected');
});

// ── 7. Replay & Idempotency (F07) ──────────────────────────────────────────

test('F07: exact replay returns original result with replayed=true and zero writes', async () => {
  const { firestore, manager, validRequest, expectedUpdatedAt, expectedSubmittedAt, storageGenerations } = setupTestEnvironment();

  const reqData = {
    requestId: VALID_REQUEST_ID,
    driverUid: DRIVER_UID,
    expectedUpdatedAt,
    expectedSubmittedAt,
    canFlatbed: true,
    canPulling: false,
    expectedObjectGenerations: storageGenerations,
  };

  // First call
  const firstResult = await manager.executeDecision({
    operation: 'adminApproveDriver',
    request: { ...validRequest, data: reqData },
  });
  assert.equal(firstResult.replayed, false);
  const writeCountAfterFirst = firestore.writeLog.length;

  // Replay
  const replayResult = await manager.executeDecision({
    operation: 'adminApproveDriver',
    request: { ...validRequest, data: reqData },
  });
  assert.equal(replayResult.replayed, true);
  assert.equal(replayResult.actionId, firstResult.actionId);
  assert.equal(replayResult.driverUid, firstResult.driverUid);
  assert.equal(replayResult.verificationStatus, firstResult.verificationStatus);

  // Exactly zero new writes performed
  assert.equal(firestore.writeLog.length, writeCountAfterFirst);
});

test('F07: NFC/NFD and outer-whitespace reason variants replay same result', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();

  const reasonNFC = 'Verification failed: invalid document details.';
  // NFD representation
  const reasonNFD = reasonNFC.normalize('NFD');

  const firstResult = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        reason: `   ${reasonNFC}   `,
      },
    },
  });
  assert.equal(firstResult.replayed, false);

  const replayResult = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        reason: reasonNFD,
      },
    },
  });
  assert.equal(replayResult.replayed, true);
  assert.equal(replayResult.actionId, firstResult.actionId);
});

test('F07: reusing request ID with changed payload fails with REQUEST_ID_REUSED', async () => {
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt, storageGenerations } = setupTestEnvironment();

  await manager.executeDecision({
    operation: 'adminApproveDriver',
    request: {
      ...validRequest,
      data: {
        requestId: VALID_REQUEST_ID,
        driverUid: DRIVER_UID,
        expectedUpdatedAt,
        expectedSubmittedAt,
        canFlatbed: true,
        canPulling: false,
        expectedObjectGenerations: storageGenerations,
      },
    },
  });

  // Reusing same requestId with changed capabilities (canPulling: true)
  await assert.rejects(
    async () => {
      await manager.executeDecision({
        operation: 'adminApproveDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            canFlatbed: true,
            canPulling: true, // changed
            expectedObjectGenerations: storageGenerations,
          },
        },
      });
    },
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'REQUEST_ID_REUSED'
  );
});

test('F07: replay of old rejection after driver resubmission does not mutate new pending application', async () => {
  const { firestore, manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();

  const reqData = {
    requestId: VALID_REQUEST_ID,
    driverUid: DRIVER_UID,
    expectedUpdatedAt,
    expectedSubmittedAt,
    reason: 'Initial rejection reason for blurred photo.',
  };

  const firstResult = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: { ...validRequest, data: reqData },
  });
  assert.equal(firstResult.verificationStatus, 'rejected');

  // Driver now resubmits application -> status becomes pending with new timestamps
  const newSubmittedTs = new Timestamp(1729400000, 0);
  const newUpdatedTs = new Timestamp(1729400000, 0);
  firestore.data.drivers[DRIVER_UID] = {
    ...firestore.data.drivers[DRIVER_UID],
    verificationStatus: 'pending',
    updatedAt: newUpdatedTs,
    verificationDocs: {
      ...firestore.data.drivers[DRIVER_UID].verificationDocs,
      submittedAt: newSubmittedTs,
    },
    rejectionReason: null,
  };

  // Admin client replays original request (e.g. unacknowledged network response)
  const replayResult = await manager.executeDecision({
    operation: 'adminRejectDriver',
    request: { ...validRequest, data: reqData },
  });

  assert.equal(replayResult.replayed, true);
  assert.equal(replayResult.verificationStatus, 'rejected'); // historical result

  // Current driver state in database MUST remain the new pending application!
  const currentDriver = firestore.data.drivers[DRIVER_UID];
  assert.equal(currentDriver.verificationStatus, 'pending');
  assert.equal(currentDriver.rejectionReason, null);
  assert.equal(currentDriver.updatedAt.seconds, newUpdatedTs.seconds);
});

test('F05 remediation: present engagement fields (false, 0, empty string) are rejected with DRIVER_ENGAGED', async () => {
  const malformedEngagement = [
    ['activeJobId', false],
    ['activeJobId', 0],
    ['activeJobId', ''],
    ['activeOfferId', false],
    ['activeOfferId', 0],
    ['activeOfferId', ''],
    ['dutySessionId', false],
    ['dutySessionId', 0],
    ['dutySessionId', ''],
    ['workerReady', null],
  ];

  for (const [field, value] of malformedEngagement) {
    const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
      driverOverrides: { [field]: value },
    });

    await assert.rejects(
      manager.executeDecision({
        operation: 'adminRejectDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            reason: 'Testing engagement rejection for malformed fields.',
          },
        },
      }),
      (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'DRIVER_ENGAGED'
    );
  }
});

test('F05 remediation: present non-boolean capability fields are rejected with APPLICATION_INVALID', async () => {
  for (const field of ['canFlatbed', 'canPulling']) {
    const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
      driverOverrides: { [field]: null },
    });

    await assert.rejects(
      manager.executeDecision({
        operation: 'adminRejectDriver',
        request: {
          ...validRequest,
          data: {
            requestId: VALID_REQUEST_ID,
            driverUid: DRIVER_UID,
            expectedUpdatedAt,
            expectedSubmittedAt,
            reason: 'Testing capability rejection for null fields.',
          },
        },
      }),
      (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'APPLICATION_INVALID'
    );
  }
});

test('F07 remediation: completed receipt replay validates exact result schema and timestamps', async () => {
  const { manager, firestore, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment();

  const reason = 'Valid rejection reason for testing replay.';
  const payloadHash = computePayloadHash({
    operation: 'adminRejectDriver',
    driverUid: DRIVER_UID,
    expectedUpdatedAt,
    expectedSubmittedAt,
    decisionValues: [reason],
  });
  const receiptDocId = computeReceiptDocId(ADMIN_UID, VALID_REQUEST_ID);

  // Seed a malformed completed receipt: missing timestamps and wrong driverUid in result
  firestore.data.processed_requests[receiptDocId] = {
    actorUid: ADMIN_UID,
    operation: 'adminRejectDriver',
    resourceId: DRIVER_UID,
    payloadHash,
    status: 'completed',
    result: {
      success: true,
      driverUid: 'OTHER_DRIVER',
      verificationStatus: 'approved',
      actionId: 'MISSING_AUDIT',
      reviewedSubmittedAt: { seconds: 0, nanoseconds: 0 },
    },
  };

  await assert.rejects(
    manager.executeDecision({
      operation: 'adminRejectDriver',
      request: {
        ...validRequest,
        data: {
          requestId: VALID_REQUEST_ID,
          driverUid: DRIVER_UID,
          expectedUpdatedAt,
          expectedSubmittedAt,
          reason,
        },
      },
    }),
    (err) => err.code === 'failed-precondition' && err.details?.reasonCode === 'MALFORMED_COMPLETED_RECEIPT'
  );
});

test('Safe errors remediation: arbitrary persisted data is not reflected in error messages', async () => {
  const arbitraryLongString = 'SYNTHETIC_PRIVATE_DATA_' + 'X'.repeat(2048);
  const { manager, validRequest, expectedUpdatedAt, expectedSubmittedAt } = setupTestEnvironment({
    driverOverrides: { truckType: arbitraryLongString },
  });

  let error;
  try {
    await manager.executeDecision({
      operation: 'adminRejectDriver',
      request: {
        ...validRequest,
        data: {
          requestId: VALID_REQUEST_ID,
          driverUid: DRIVER_UID,
          expectedUpdatedAt,
          expectedSubmittedAt,
          reason: 'Testing safe error messages.',
        },
      },
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error);
  assert.equal(error.code, 'failed-precondition');
  assert.equal(error.message, 'Driver application has invalid truckType');
  assert.ok(!error.message.includes('SYNTHETIC_PRIVATE_DATA_'));
  assert.ok(error.message.length < 100);
});

