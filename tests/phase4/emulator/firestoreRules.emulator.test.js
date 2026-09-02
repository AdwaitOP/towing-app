'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'towing-phase4-rules';

if (!HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is required; this suite must run against the real Firestore Emulator.');
}

const DATABASE_ROOT = `http://${HOST}/v1/projects/${PROJECT_ID}/databases/(default)`;
const DOCUMENTS_ROOT = `${DATABASE_ROOT}/documents`;
const EMULATOR_ROOT = `http://${HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)`;
const NOW = '2026-08-28T12:00:00.000Z';
const RUN = randomUUID().replaceAll('-', '').slice(0, 12);

const IDS = {
  driverA: `driver-a-${RUN}`,
  driverB: `driver-b-${RUN}`,
  legacyDriver: `legacy-driver-${RUN}`,
  newDriver: `new-driver-${RUN}`,
  protectedDriver: `protected-driver-${RUN}`,
  stranger: `stranger-${RUN}`,
  admin: `admin-${RUN}`,
  jobOffered: `job-offered-${RUN}`,
  jobAssigned: `job-assigned-${RUN}`,
  offerA: `offer-a-${RUN}`,
  offerAAccepted: `offer-a-accepted-${RUN}`,
  offerB: `offer-b-${RUN}`,
  run: `run-${RUN}`,
  receipt: `request-${RUN}`,
  outbox: `event-${RUN}`
};

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function authToken(uid, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: uid,
    user_id: uid,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    iat: now,
    exp: now + 3600,
    firebase: { sign_in_provider: 'custom', identities: {} },
    ...claims
  }));
  return `${header}.${payload}.`;
}

const AUTH = {
  owner: 'owner',
  driverA: authToken(IDS.driverA),
  driverB: authToken(IDS.driverB),
  legacyDriver: authToken(IDS.legacyDriver),
  newDriver: authToken(IDS.newDriver),
  protectedDriver: authToken(IDS.protectedDriver),
  stranger: authToken(IDS.stranger),
  admin: authToken(IDS.admin, { admin: true })
};

function timestamp(value = NOW) {
  return { __firestoreTimestamp: value };
}

function geo(latitude, longitude) {
  return { __firestoreGeoPoint: { latitude, longitude } };
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (value && value.__firestoreTimestamp) {
    return { timestampValue: value.__firestoreTimestamp };
  }
  if (value && value.__firestoreGeoPoint) {
    return { geoPointValue: value.__firestoreGeoPoint };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value) } };
  }
  throw new TypeError(`Unsupported Firestore test value: ${typeof value}`);
}

function encodeFields(fields) {
  return Object.fromEntries(Object.entries(fields)
    .map(([key, value]) => [key, encodeValue(value)]));
}

function documentBody(fields) {
  return { fields: encodeFields(fields) };
}

async function rawRequest(url, { method = 'GET', auth, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}

async function firestoreRequest(method, path, auth, body, query = '') {
  return rawRequest(`${DOCUMENTS_ROOT}/${path}${query}`, { method, auth, body });
}

async function clearEmulator() {
  const result = await rawRequest(`${EMULATOR_ROOT}/documents`, { method: 'DELETE' });
  assert.equal(result.ok, true,
    `isolated emulator flush: ${result.status} ${result.text}`);
}

async function writeAsBackend(path, fields) {
  const result = await firestoreRequest('PATCH', path, AUTH.owner, documentBody(fields));
  assert.equal(result.ok, true,
    `backend seed ${path}: ${result.status} ${result.text}`);
}

async function patchFields(path, auth, fields) {
  const query = Object.keys(fields)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');
  return firestoreRequest('PATCH', path, auth, documentBody(fields), `?${query}`);
}

async function commitUpdate(path, auth, {
  fields = {}, deleteFields = [], serverTimestamps = ['updatedAt']
} = {}) {
  const name = `projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const fieldPaths = [...Object.keys(fields), ...deleteFields];
  const write = {
    update: { name, fields: encodeFields(fields) },
    ...(fieldPaths.length ? { updateMask: { fieldPaths } } : {}),
    ...(serverTimestamps.length ? {
      updateTransforms: serverTimestamps.map((fieldPath) => ({
        fieldPath,
        setToServerValue: 'REQUEST_TIME'
      }))
    } : {})
  };
  return rawRequest(`${DATABASE_ROOT}/documents:commit`, {
    method: 'POST',
    auth,
    body: { writes: [write] }
  });
}

function assertAllowed(result, label) {
  assert.equal(result.ok, true,
    `${label}: expected allow, got ${result.status} ${result.text}`);
}

function assertDenied(result, label) {
  assert.equal(result.status, 403,
    `${label}: expected HTTP 403, got ${result.status} ${result.text}`);
}

function driverDocument(uid, verificationStatus = 'approved') {
  return {
    uid,
    name: `Driver ${uid}`,
    phone: '+919000000001',
    truckType: 'flatbed',
    vehicleNumber: 'MH-01-AA-0001',
    isOnDuty: true,
    location: geo(19.076, 72.8777),
    locationUpdatedAt: timestamp(),
    walletBalance: 50000,
    canFlatbed: true,
    canPulling: false,
    activeJobId: null,
    activeOfferId: IDS.offerA,
    verificationStatus,
    verificationDocs: {
      idPhotoUrl: 'gs://test/id.jpg',
      rcPhotoUrl: 'gs://test/rc.jpg',
      selfiePhotoUrl: 'gs://test/selfie.jpg',
      submittedAt: timestamp()
    },
    rejectionReason: null,
    bannedUntil: null,
    strictMode: false,
    monthlyCancelCount: { month: '2026-08', count: 0 },
    createdAt: timestamp(),
    updatedAt: timestamp()
  };
}

async function runOfferQuery(auth, { driverId, status, orderByOfferedAt = false } = {}) {
  const filters = [];
  if (driverId !== undefined) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: 'driverId' },
        op: 'EQUAL',
        value: { stringValue: driverId }
      }
    });
  }
  if (status !== undefined) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: 'status' },
        op: 'EQUAL',
        value: { stringValue: status }
      }
    });
  }
  const where = filters.length === 0
    ? undefined
    : filters.length === 1
      ? filters[0]
      : { compositeFilter: { op: 'AND', filters } };
  const result = await rawRequest(`${DATABASE_ROOT}/documents:runQuery`, {
    method: 'POST',
    auth,
    body: {
      structuredQuery: {
        from: [{ collectionId: 'job_offers' }],
        ...(where ? { where } : {}),
        ...(orderByOfferedAt ? {
          orderBy: [{ field: { fieldPath: 'offeredAt' }, direction: 'DESCENDING' }]
        } : {})
      }
    }
  });
  if (!result.ok) return result;
  const rows = JSON.parse(result.text);
  return {
    ...result,
    documents: rows.filter(({ document }) => document).map(({ document }) => ({
      id: document.name.split('/').at(-1),
      driverId: document.fields.driverId.stringValue,
      status: document.fields.status.stringValue
    }))
  };
}

test('Phase 4 Stage 1 Firestore rules enforce the exact isolated client boundary', async (t) => {
  await clearEmulator();

  await writeAsBackend(`drivers/${IDS.driverA}`, driverDocument(IDS.driverA));
  await writeAsBackend(`drivers/${IDS.driverB}`, driverDocument(IDS.driverB, 'pending'));
  const legacy = driverDocument(IDS.legacyDriver, 'pending');
  delete legacy.canPulling;
  delete legacy.activeJobId;
  delete legacy.activeOfferId;
  await writeAsBackend(`drivers/${IDS.legacyDriver}`, legacy);

  await writeAsBackend(`jobs/${IDS.jobOffered}`, {
    customerPhone: '+919876543210',
    status: 'offered',
    offeredTo: IDS.driverA,
    assignedDriver: null,
    razorpayPaymentId: 'pay_secret_for_rules_test'
  });
  await writeAsBackend(`jobs/${IDS.jobAssigned}`, {
    customerPhone: '+919876543211',
    status: 'accepted',
    offeredTo: IDS.driverA,
    assignedDriver: IDS.driverA,
    razorpayPaymentId: 'pay_other_secret'
  });
  await writeAsBackend(`job_offers/${IDS.offerA}`, {
    jobId: IDS.jobOffered,
    driverId: IDS.driverA,
    status: 'offered',
    offeredAt: timestamp('2026-08-28T12:00:02.000Z'),
    expiresAt: timestamp('2026-08-28T12:00:47.000Z')
  });
  await writeAsBackend(`job_offers/${IDS.offerAAccepted}`, {
    jobId: IDS.jobAssigned,
    driverId: IDS.driverA,
    status: 'accepted',
    offeredAt: timestamp('2026-08-28T12:00:01.000Z'),
    expiresAt: timestamp('2026-08-28T12:00:46.000Z')
  });
  await writeAsBackend(`job_offers/${IDS.offerB}`, {
    jobId: IDS.jobOffered,
    driverId: IDS.driverB,
    status: 'offered',
    offeredAt: timestamp('2026-08-28T12:00:00.000Z'),
    expiresAt: timestamp('2026-08-28T12:00:45.000Z')
  });
  await writeAsBackend(`jobs/${IDS.jobOffered}/dispatch_runs/${IDS.run}`, {
    jobId: IDS.jobOffered, generation: 1, status: 'active', nextCandidateIndex: 0
  });
  const ledgerId = `commission_debit:${IDS.jobOffered}:${IDS.offerA}`;
  await writeAsBackend(`wallet_entries/${ledgerId}`, {
    operationId: ledgerId,
    driverId: IDS.driverA,
    jobId: IDS.jobOffered,
    offerId: IDS.offerA,
    deltaPaise: -20000,
    createdAt: timestamp()
  });
  await writeAsBackend(`refund_requests/${IDS.jobOffered}`, {
    operationId: IDS.jobOffered,
    jobId: IDS.jobOffered,
    state: 'pending',
    amountPaise: 10000,
    createdAt: timestamp()
  });
  await writeAsBackend(`notification_outbox/${IDS.outbox}`, {
    eventId: IDS.outbox,
    resourceId: IDS.jobOffered,
    state: 'pending',
    channel: 'whatsapp',
    createdAt: timestamp()
  });
  await writeAsBackend(`processed_requests/${IDS.receipt}`, {
    requestId: IDS.receipt,
    actorUid: IDS.driverA,
    operation: 'accept',
    resourceId: `${IDS.jobOffered}/${IDS.offerA}`,
    status: 'completed'
  });
  await writeAsBackend('usage_counters/2026-08', {
    olaMapsMatrixRequests: 1,
    olaMapsMatrixPairs: 2,
    whatsappTemplateSends: 0,
    updatedAt: timestamp()
  });
  await writeAsBackend('dispatch_config/main', {
    version: 1,
    locationFreshnessSeconds: 120,
    radiusKmSequence: [10, 20, 35]
  });
  await writeAsBackend('pricing_config/main', {
    cancellation_policy: {
      version: 1,
      timezone: 'Asia/Kolkata',
      roundingMode: 'HALF_UP'
    }
  });

  const sensitiveResources = [
    {
      label: 'jobs', existingPath: `jobs/${IDS.jobOffered}`,
      readPath: `jobs/${IDS.jobOffered}`, createPath: `jobs/client-create-${RUN}`,
      createFields: { status: 'pending_offer' }, updateFields: { status: 'accepted' }
    },
    {
      label: 'job_offers', existingPath: `job_offers/${IDS.offerA}`,
      readPath: `job_offers/${IDS.offerB}`, createPath: `job_offers/client-create-${RUN}`,
      createFields: { jobId: IDS.jobOffered, driverId: IDS.driverA, status: 'offered' },
      updateFields: { status: 'accepted' }
    },
    {
      label: 'dispatch_runs',
      existingPath: `jobs/${IDS.jobOffered}/dispatch_runs/${IDS.run}`,
      readPath: `jobs/${IDS.jobOffered}/dispatch_runs/${IDS.run}`,
      createPath: `jobs/${IDS.jobOffered}/dispatch_runs/client-create-${RUN}`,
      createFields: { jobId: IDS.jobOffered, status: 'active' },
      updateFields: { status: 'exhausted' }
    },
    {
      label: 'wallet_entries', existingPath: `wallet_entries/${ledgerId}`,
      readPath: `wallet_entries/${ledgerId}`,
      createPath: `wallet_entries/client-create-${RUN}`,
      createFields: { driverId: IDS.driverA, jobId: IDS.jobOffered, deltaPaise: 1 },
      updateFields: { deltaPaise: 0 }
    },
    {
      label: 'refund_requests', existingPath: `refund_requests/${IDS.jobOffered}`,
      readPath: `refund_requests/${IDS.jobOffered}`,
      createPath: `refund_requests/client-create-${RUN}`,
      createFields: { jobId: IDS.jobOffered, state: 'pending' },
      updateFields: { state: 'submitted' }
    },
    {
      label: 'notification_outbox', existingPath: `notification_outbox/${IDS.outbox}`,
      readPath: `notification_outbox/${IDS.outbox}`,
      createPath: `notification_outbox/client-create-${RUN}`,
      createFields: { eventId: `client-create-${RUN}`, state: 'pending' },
      updateFields: { state: 'sent' }
    },
    {
      label: 'processed_requests', existingPath: `processed_requests/${IDS.receipt}`,
      readPath: `processed_requests/${IDS.receipt}`,
      createPath: `processed_requests/client-create-${RUN}`,
      createFields: { requestId: `client-create-${RUN}`, status: 'in_progress' },
      updateFields: { status: 'in_progress' }
    },
    {
      label: 'usage_counters', existingPath: 'usage_counters/2026-08',
      readPath: 'usage_counters/2026-08', createPath: `usage_counters/client-${RUN}`,
      createFields: { olaMapsMatrixPairs: 1 }, updateFields: { olaMapsMatrixPairs: 3 }
    }
  ];

  await t.test('clean state permits a repeatable self profile create and authenticated config read', async () => {
    const profile = {
      uid: IDS.newDriver,
      name: 'New Driver',
      phone: '+919000000099',
      truckType: 'flatbed',
      vehicleNumber: 'MH-03-CC-0003',
      isOnDuty: false,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    assertAllowed(await firestoreRequest('PATCH', `drivers/${IDS.newDriver}`,
      AUTH.newDriver, documentBody(profile)), 'allow-listed profile create');
    assertDenied(await firestoreRequest('PATCH', `drivers/${IDS.protectedDriver}`,
      AUTH.protectedDriver,
      documentBody({ ...profile, uid: IDS.protectedDriver, walletBalance: 1000 })),
    'profile create with protected wallet field');
    assertAllowed(await firestoreRequest('GET', 'pricing_config/main', AUTH.stranger),
      'authenticated pricing read');
  });

  await t.test('every sensitive Stage 1 resource denies unauthenticated CRUD', async () => {
    for (const resource of sensitiveResources) {
      assertDenied(await firestoreRequest('GET', resource.readPath),
        `unauthenticated ${resource.label} read`);
      assertDenied(await firestoreRequest('PATCH', resource.createPath, null,
        documentBody(resource.createFields)), `unauthenticated ${resource.label} create`);
      assertDenied(await patchFields(resource.existingPath, null, resource.updateFields),
        `unauthenticated ${resource.label} update`);
      assertDenied(await firestoreRequest('DELETE', resource.existingPath),
        `unauthenticated ${resource.label} delete`);
    }
  });

  await t.test('authenticated drivers cannot CRUD backend-owned Stage 1 resources', async () => {
    for (const resource of sensitiveResources) {
      assertDenied(await firestoreRequest('GET', resource.readPath, AUTH.driverA),
        `driver ${resource.label} unauthorized read`);
      assertDenied(await firestoreRequest('PATCH', resource.createPath, AUTH.driverA,
        documentBody(resource.createFields)), `driver ${resource.label} create`);
      assertDenied(await patchFields(resource.existingPath, AUTH.driverA,
        resource.updateFields), `driver ${resource.label} update`);
      assertDenied(await firestoreRequest('DELETE', resource.existingPath, AUTH.driverA),
        `driver ${resource.label} delete`);
    }
  });

  await t.test('offered and assigned drivers cannot read or write raw jobs', async () => {
    assertDenied(await firestoreRequest('GET', `jobs/${IDS.jobOffered}`, AUTH.driverA),
      'offered driver raw job');
    assertDenied(await firestoreRequest('GET', `jobs/${IDS.jobAssigned}`, AUTH.driverA),
      'assigned driver raw job');
    assertDenied(await firestoreRequest('PATCH', `jobs/${IDS.jobOffered}`, AUTH.driverA,
      documentBody({ status: 'accepted' })), 'driver raw job write');
    assertDenied(await firestoreRequest('PATCH', `jobs/${IDS.jobOffered}`, AUTH.admin,
      documentBody({ status: 'cancelled_customer' })), 'admin client raw job write');
  });

  await t.test('realistic own-offer feed query is constrained and returns only approved rows', async () => {
    const ownFeed = await runOfferQuery(AUTH.driverA, {
      driverId: IDS.driverA,
      status: 'offered',
      orderByOfferedAt: true
    });
    assertAllowed(ownFeed, 'own offered feed query');
    assert.deepEqual(ownFeed.documents, [{
      id: IDS.offerA,
      driverId: IDS.driverA,
      status: 'offered'
    }]);

    assertDenied(await runOfferQuery(AUTH.driverA), 'unconstrained offer query');
    assertDenied(await runOfferQuery(AUTH.driverA, { status: 'offered' }),
      'status-only offer query');
    assertDenied(await runOfferQuery(AUTH.driverA, {
      driverId: IDS.driverB,
      status: 'offered',
      orderByOfferedAt: true
    }), 'another driver feed query');
    assertDenied(await runOfferQuery(null, {
      driverId: IDS.driverA,
      status: 'offered',
      orderByOfferedAt: true
    }), 'unauthenticated own-shaped offer query');
    assertAllowed(await firestoreRequest('GET', `job_offers/${IDS.offerA}`, AUTH.driverA),
      'own offer direct read');
    assertDenied(await firestoreRequest('GET', `job_offers/${IDS.offerB}`, AUTH.driverA),
      'other offer direct read');
  });

  await t.test('protected driver fields reject add, delete, type-change, nested replacement, and mixed updates', async () => {
    assertDenied(await commitUpdate(`drivers/${IDS.legacyDriver}`, AUTH.legacyDriver, {
      fields: { canPulling: true }
    }), 'add previously absent capability');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      deleteFields: ['walletBalance']
    }), 'delete protected wallet');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { verificationStatus: 7 }
    }), 'type-change verification');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { monthlyCancelCount: { month: '2026-08', count: 99 } }
    }), 'replace protected nested cancellation state');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { name: 'Allowed Name', walletBalance: 1 }
    }), 'allowed and forbidden fields in one update');
  });

  await t.test('Blocker 4E: complete protected field coverage - owner cannot mutate any backend-controlled field even with valid request-time updatedAt', async () => {
    const protectedMutations = [
      ['walletBalance', 999999],
      ['verificationStatus', 'rejected'],
      ['canFlatbed', false],
      ['canPulling', true],
      ['activeJobId', IDS.jobOffered],
      ['activeOfferId', null],
      ['bannedUntil', timestamp('2026-09-01T00:00:00.000Z')],
      ['strictMode', true],
      ['monthlyCancelCount', { month: '2026-08', count: 9 }],
      ['verificationDocs', { idPhotoUrl: 'gs://hack/id.jpg' }],
      ['rejectionReason', 'docs_invalid'],
      ['uid', IDS.driverB],
      ['phone', '+919999988888'],
      ['createdAt', timestamp('2020-01-01T00:00:00.000Z')]
    ];
    for (const [field, value] of protectedMutations) {
      assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
        fields: { [field]: value },
        serverTimestamps: ['updatedAt']
      }), `owner update of protected field ${field} with valid updatedAt`);
    }
  });

  await t.test('admin clients cannot mutate wallet, verification, capability, or engagement', async () => {
    for (const [field, value] of [
      ['walletBalance', 1],
      ['verificationStatus', 'rejected'],
      ['canFlatbed', false],
      ['activeJobId', IDS.jobOffered]
    ]) {
      assertDenied(await patchFields(`drivers/${IDS.driverA}`, AUTH.admin,
        { [field]: value }), `admin ${field}`);
    }
  });

  await t.test('approved vehicle identity is locked; pending legitimate self-service uses request-time updatedAt', async () => {
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { truckType: 'crane' }
    }), 'approved truck change');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { vehicleNumber: 'MH-02-BB-0002' }
    }), 'approved plate change');
    assertAllowed(await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverB, {
      fields: { truckType: 'tochan' }
    }), 'pending truck correction');
    assertAllowed(await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverB, {
      fields: { isOnDuty: false }
    }), 'duty toggle');
    assertAllowed(await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverB, {
      fields: { name: 'Corrected Name' }
    }), 'name correction');
    assertDenied(await patchFields(`drivers/${IDS.driverB}`, AUTH.driverB,
      { name: 'No Timestamp' }), 'self-service update without request-time updatedAt');
  });

  await t.test('stationary and moving location reports require paired request-time freshness', async () => {
    const original = geo(19.076, 72.8777);
    const changed = geo(19.08, 72.88);
    assertAllowed(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { location: original },
      serverTimestamps: ['locationUpdatedAt', 'updatedAt']
    }), 'same coordinate with fresh request time');
    assertAllowed(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { location: changed },
      serverTimestamps: ['locationUpdatedAt', 'updatedAt']
    }), 'changed coordinate with fresh request time');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { location: geo(19.09, 72.89) },
      serverTimestamps: ['updatedAt']
    }), 'changed coordinate without location timestamp');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: {
        location: changed,
        locationUpdatedAt: timestamp('2020-01-01T00:00:00.000Z')
      },
      serverTimestamps: ['updatedAt']
    }), 'same coordinate with arbitrary timestamp');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      deleteFields: ['locationUpdatedAt'],
      serverTimestamps: ['updatedAt']
    }), 'location timestamp deletion');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      deleteFields: ['location'],
      serverTimestamps: ['locationUpdatedAt', 'updatedAt']
    }), 'location field deletion');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { location: null },
      serverTimestamps: ['locationUpdatedAt', 'updatedAt']
    }), 'location null');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { locationUpdatedAt: null },
      serverTimestamps: ['updatedAt']
    }), 'location timestamp null');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      deleteFields: ['location', 'locationUpdatedAt'],
      serverTimestamps: ['updatedAt']
    }), 'both location fields deleted');
    assertDenied(await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
      fields: { location: 'not-a-geopoint' },
      serverTimestamps: ['locationUpdatedAt', 'updatedAt']
    }), 'malformed location');
  });

  await t.test('usage counters also deny admin clients', async () => {
    assertDenied(await firestoreRequest('GET', 'usage_counters/2026-08', AUTH.admin),
      'admin usage read');
    assertDenied(await patchFields('usage_counters/2026-08', AUTH.admin,
      { olaMapsMatrixPairs: 3 }), 'admin usage write');
  });

  await t.test('admin claim receives approved reads but no backend-only writes', async () => {
    for (const path of [
      `jobs/${IDS.jobOffered}`,
      `jobs/${IDS.jobOffered}/dispatch_runs/${IDS.run}`,
      `job_offers/${IDS.offerA}`,
      `wallet_entries/${ledgerId}`,
      `refund_requests/${IDS.jobOffered}`,
      `notification_outbox/${IDS.outbox}`,
      'dispatch_config/main'
    ]) assertAllowed(await firestoreRequest('GET', path, AUTH.admin),
      `admin read ${path}`);
    assertDenied(await patchFields(`refund_requests/${IDS.jobOffered}`, AUTH.admin,
      { state: 'submitted' }), 'admin refund write');
  });

  await t.test('owner bypass proves backend writes remain possible', async () => {
    assertAllowed(await patchFields(`drivers/${IDS.driverA}`, AUTH.owner,
      { walletBalance: 49999 }), 'backend driver write');
    assertAllowed(await patchFields(`job_offers/${IDS.offerA}`, AUTH.owner,
      { status: 'accepted' }), 'backend offer write');
    assertAllowed(await patchFields(`refund_requests/${IDS.jobOffered}`, AUTH.owner,
      { state: 'submitted' }), 'backend refund write');
    assertAllowed(await patchFields('usage_counters/2026-08', AUTH.owner,
      { olaMapsMatrixPairs: 3 }), 'backend usage write');
  });

  // Blocker 5B — Driver profile Firestore rules: complete security coverage
  // Seed an unauthenticated profile target
  const unauthedProfilePath = `drivers/${IDS.protectedDriver}`;
  // Use protectedDriver (created via writeAsBackend) — already in the emulator from the t.test above
  // (the create attempt by protectedDriver with protected fields was denied; doc is not created)
  // Write it as backend so read tests work:
  await writeAsBackend(unauthedProfilePath, driverDocument(IDS.protectedDriver));

  await t.test('unauthenticated clients are denied ALL driver profile operations', async () => {
    // GET (read) — unauthenticated
    assertDenied(
      await firestoreRequest('GET', `drivers/${IDS.driverA}`),
      'unauthenticated driver profile read'
    );
    // CREATE (PATCH with full doc) — unauthenticated
    const freshProfile = {
      uid: `unauth-create-${RUN}`,
      name: 'Intruder',
      phone: '+919999999999',
      truckType: 'flatbed',
      vehicleNumber: 'MH-99-ZZ-9999',
      isOnDuty: false,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    assertDenied(
      await firestoreRequest('PATCH', `drivers/unauth-create-${RUN}`, null, documentBody(freshProfile)),
      'unauthenticated driver profile create'
    );
    // UPDATE — unauthenticated
    assertDenied(
      await patchFields(`drivers/${IDS.driverA}`, null, { isOnDuty: false }),
      'unauthenticated driver profile update'
    );
    // DELETE — unauthenticated
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverA}`),
      'unauthenticated driver profile delete'
    );
    // Unauthenticated pricing_config must be denied
    assertDenied(
      await firestoreRequest('GET', 'pricing_config/main'),
      'unauthenticated pricing_config read'
    );
  });

  await t.test('Blocker 4A-4D: cross-driver authorization boundaries for read, create, update, and delete', async () => {
    // 4C: Cross-Driver Read
    // driverA cannot read driverB's profile
    assertDenied(
      await firestoreRequest('GET', `drivers/${IDS.driverB}`, AUTH.driverA),
      'cross-driver profile read (driverA -> driverB)'
    );
    // driverB cannot read driverA's profile
    assertDenied(
      await firestoreRequest('GET', `drivers/${IDS.driverA}`, AUTH.driverB),
      'cross-driver profile read (driverB -> driverA)'
    );
    // stranger (authenticated but not a driver document owner) cannot read driverA's profile
    assertDenied(
      await firestoreRequest('GET', `drivers/${IDS.driverA}`, AUTH.stranger),
      'stranger profile read (stranger -> driverA)'
    );

    // 4A: Cross-Driver Update
    // Construct an update payload that WOULD be 100% valid if executed by driverB (owner)
    const validOwnerUpdateForDriverB = {
      fields: { name: 'Valid Driver Name Update' },
      serverTimestamps: ['updatedAt']
    };
    // Execute this exact owner-valid payload as driverA -> must be DENIED solely by auth UID mismatch
    assertDenied(
      await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverA, validOwnerUpdateForDriverB),
      'cross-driver update with owner-valid payload (driverA -> driverB)'
    );
    // Verify that the matching driver profile owner (driverB) CAN execute this update
    assertAllowed(
      await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverB, validOwnerUpdateForDriverB),
      'matching owner profile update (driverB -> driverB)'
    );

    // 4B: Cross-Driver Create
    // Execute create with valid driver payload on a fresh nonexistent document ID as mismatched driverA
    const freshDriverUid = `fresh-driver-${RUN}`;
    const freshProfilePayload = {
      uid: freshDriverUid,
      name: 'Fresh Driver',
      phone: '+919876543210',
      truckType: 'flatbed',
      vehicleNumber: 'MH-05-EE-0005',
      isOnDuty: false,
      createdAt: timestamp(),
      updatedAt: timestamp()
    };
    // Mismatched driverA attempts to create freshDriverUid -> DENIED solely because actor UID != document ID
    assertDenied(
      await firestoreRequest('PATCH', `drivers/${freshDriverUid}`, AUTH.driverA,
        documentBody(freshProfilePayload)),
      'cross-driver create on nonexistent document (driverA -> freshDriverUid)'
    );
    // Matching driver authToken(freshDriverUid) creates freshDriverUid -> ALLOWED
    assertAllowed(
      await firestoreRequest('PATCH', `drivers/${freshDriverUid}`, authToken(freshDriverUid),
        documentBody(freshProfilePayload)),
      'matching driver creates fresh document (freshDriverUid -> freshDriverUid)'
    );

    // 4D: Cross-Driver Delete and Owner Delete
    // driverA cannot delete driverB profile
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverB}`, AUTH.driverA),
      'cross-driver profile delete (driverA -> driverB)'
    );
    // driverB cannot delete driverA profile
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverA}`, AUTH.driverB),
      'cross-driver profile delete (driverB -> driverA)'
    );
    // Owner cannot delete own profile
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverA}`, AUTH.driverA),
      'owner cannot delete own profile'
    );
  });

  await t.test('owner can read own profile; admin-controlled mutations are denied on self', async () => {
    // Owner reads own profile — must be allowed
    assertAllowed(
      await firestoreRequest('GET', `drivers/${IDS.driverA}`, AUTH.driverA),
      'owner reads own profile'
    );
    // Admin reads own profile via admin claim — must be allowed
    assertAllowed(
      await firestoreRequest('GET', `drivers/${IDS.driverA}`, AUTH.admin),
      'admin reads driverA profile'
    );
    // Owner cannot set verificationStatus directly (e.g. driverA trying to set rejected, driverB trying to set approved)
    assertDenied(
      await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
        fields: { verificationStatus: 'rejected' }
      }),
      'owner cannot self-set verificationStatus to rejected'
    );
    assertDenied(
      await commitUpdate(`drivers/${IDS.driverB}`, AUTH.driverB, {
        fields: { verificationStatus: 'approved' }
      }),
      'pending owner cannot self-approve verificationStatus'
    );
    // Owner cannot set canFlatbed directly
    assertDenied(
      await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
        fields: { canFlatbed: false }
      }),
      'owner cannot self-set canFlatbed'
    );
    // Owner cannot set walletBalance directly
    assertDenied(
      await commitUpdate(`drivers/${IDS.driverA}`, AUTH.driverA, {
        fields: { walletBalance: 0 }
      }),
      'owner cannot self-set walletBalance'
    );
    // Owner cannot delete own profile
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverA}`, AUTH.driverA),
      'owner cannot delete own profile'
    );
  });

  await t.test('admin clients cannot directly write driver profiles (all driver writes denied from client)', async () => {
    // Admin cannot create a new driver profile
    assertDenied(
      await firestoreRequest('PATCH', `drivers/admin-created-${RUN}`, AUTH.admin,
        documentBody({ uid: `admin-created-${RUN}`, name: 'Admin Created', phone: '+910000000000',
          truckType: 'crane', vehicleNumber: 'MH-77-AA-7777', isOnDuty: false,
          createdAt: timestamp(), updatedAt: timestamp() })),
      'admin cannot create driver profile'
    );
    // Admin cannot update any driver profile field
    assertDenied(
      await patchFields(`drivers/${IDS.driverA}`, AUTH.admin, { name: 'Admin Renamed' }),
      'admin cannot update driver name'
    );
    assertDenied(
      await patchFields(`drivers/${IDS.driverA}`, AUTH.admin, { isOnDuty: false }),
      'admin cannot update driver duty status'
    );
    // Admin cannot delete a driver profile
    assertDenied(
      await firestoreRequest('DELETE', `drivers/${IDS.driverA}`, AUTH.admin),
      'admin cannot delete driver profile'
    );
  });
});
