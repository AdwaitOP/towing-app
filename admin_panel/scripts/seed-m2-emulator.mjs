#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Phase 6 M2 Emulator Seed Tool (M2-ARCH-1, Section 8)
 *
 * Requirements:
 * - Fail-closed loopback and project validation (demo-towmitra-admin)
 * - Purely synthetic, nonidentifying test fixtures
 * - Seeds Storage emulator with synthetic 1x1 valid JPEGs for evidence review
 * - Seeds Drivers: pending (race, missing-file, invalid, stale, 8-field, pilot-provisioned, 30 paginated), approved, rejected
 * - Seeds Jobs: default active set (pending_offer, offered, accepted, in_progress, hold, retry, cancel-pending, 30 paginated), awaiting_payment, terminal states
 * - Seeds dispatch_runs and offers subcollections
 * - Never modifies unrelated existing data
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

// Strict Fail-Closed Environment Checks
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const firestoreHost = validateEmulatorHost('FIRESTORE_EMULATOR_HOST', process.env.FIRESTORE_EMULATOR_HOST).value;
const storageHost = validateEmulatorHost('FIREBASE_STORAGE_EMULATOR_HOST', process.env.FIREBASE_STORAGE_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = storageHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

const app = getApps().length === 0 ? initializeApp({ projectId: EXPECTED_PROJECT_ID }) : getApps()[0];
const adminAuth = getAuth(app);
const adminDb = getFirestore(app);
const adminStorage = getStorage(app);
const BUCKET_NAME = `${EXPECTED_PROJECT_ID}.appspot.com`;
const bucket = adminStorage.bucket(BUCKET_NAME);

// Valid 1x1 minimal JPEG bytes (149 bytes, valid JFIF header, nonidentifying)
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9
]);

async function uploadKycFiles(driverUid, filesToUpload = ['id.jpg', 'rc.jpg', 'selfie.jpg']) {
  const generations = {};
  for (const filename of filesToUpload) {
    const filePath = `driver_verification/${driverUid}/${filename}`;
    const file = bucket.file(filePath);
    await file.save(MINIMAL_JPEG, { contentType: 'image/jpeg' });
    const [metadata] = await file.getMetadata();
    generations[filename.replace('.jpg', '')] = String(metadata.generation);
  }
  return generations;
}

export async function seedM2Fixtures() {
  console.log('\n=== TowMitra Phase 6 M2 Synthetic Fixtures Seeding ===');
  console.log(`Project: ${projectId}`);
  console.log(`Firestore: ${firestoreHost}`);
  console.log(`Storage: ${storageHost}`);

  // Base timestamps (fixed deterministic base: 2026-10-19 00:00:00 UTC)
  const baseSeconds = 1792368000;
  const t = (offsetSec, nano = 0) => new Timestamp(baseSeconds + offsetSec, nano);

  // 0. Seed Admin Auth Users
  console.log('\n0. Seeding Admin Auth Users...');
  const adminUsers = [
    { email: 'admin@towmitra.test', password: 'AdminPassword123!', uid: 'admin-a-test-uid' },
    { email: 'admin-b@towmitra.test', password: 'AdminPassword123!', uid: 'admin-b-test-uid' },
  ];
  for (const user of adminUsers) {
    try {
      await adminAuth.createUser({
        uid: user.uid,
        email: user.email,
        password: user.password,
      });
    } catch (err) {
      if (err.code !== 'auth/uid-already-exists' && err.code !== 'auth/email-already-exists') {
        throw err;
      }
    }
    await adminAuth.setCustomUserClaims(user.uid, { admin: true });
    console.log(`  Admin user seeded: ${user.email} (${user.uid}) [admin: true]`);
  }

  // 0.1 Seed Server Authorization Proof Document
  await adminDb.collection('dispatch_config').doc('main').set({
    dispatchEngineVersion: '2.0.0-emulator',
    baseEtaThresholdMinutes: 45,
    locationFreshnessSeconds: 120,
    radiusKmSequence: [10, 20, 35],
    maxUniqueCandidatesPerGeneration: 30,
    maxMatrixShortlistPerRound: 10,
    syntheticFixture: true,
    updatedAt: t(0),
  }, { merge: true });
  console.log('  Seeded dispatch_config/main in Firestore emulator.');

  // 1. Seed Storage Evidence & Drivers
  console.log('\n1. Seeding Driver Verification Fixtures...');

  // Standard valid drivers
  const standardDrivers = [
    {
      uid: 'm2-drv-pending-race1',
      name: 'Aarav Shinde',
      vehicleNumber: 'MH46BA1001',
      phone: '+919820011001',
      truckType: 'flatbed',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: t(100),
      updatedAt: t(200, 111000),
      submittedAt: t(200, 111000),
    },
    {
      uid: 'm2-drv-pending-race2',
      name: 'Vivaan Kadam',
      vehicleNumber: 'MH43CD2002',
      phone: '+919820011002',
      truckType: 'tochan',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: t(105),
      updatedAt: t(205, 222000),
      submittedAt: t(205, 222000),
    },
    {
      uid: 'm2-drv-approved-1',
      name: 'Aditya More',
      vehicleNumber: 'MH04EF3003',
      phone: '+919820011003',
      truckType: 'hydraulic',
      verificationStatus: 'approved',
      canFlatbed: true,
      canPulling: true,
      isOnDuty: false,
      createdAt: t(50),
      updatedAt: t(150, 0),
      submittedAt: t(120, 0),
    },
    {
      uid: 'm2-drv-rejected-1',
      name: 'Rohan Sawant',
      vehicleNumber: 'MH06GH4004',
      phone: '+919820011004',
      truckType: 'flatbed',
      verificationStatus: 'rejected',
      canFlatbed: false,
      canPulling: false,
      rejectionReason: 'Vehicle registration certificate is blurry and unreadable.',
      isOnDuty: false,
      createdAt: t(60),
      updatedAt: t(160, 0),
      submittedAt: t(130, 0),
    },
    {
      uid: 'm2-drv-resubmitted-1',
      name: 'Sahil Deshmukh',
      vehicleNumber: 'MH12IJ5005',
      phone: '+919820011005',
      truckType: 'tochan',
      verificationStatus: 'pending', // Was rejected, now pending
      isOnDuty: false,
      createdAt: t(40),
      updatedAt: t(250, 333000),
      submittedAt: t(250, 333000),
    },
    {
      uid: 'm2-drv-stale-review',
      name: 'Tanmay Naik',
      vehicleNumber: 'MH14KL6006',
      phone: '+919820011006',
      truckType: 'flatbed',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: t(110),
      updatedAt: t(210, 444000),
      submittedAt: t(210, 444000),
    },
    {
      uid: 'm2-drv-changed-gen',
      name: 'Kunal Gokhale',
      vehicleNumber: 'MH46MN7007',
      phone: '+919820011007',
      truckType: 'crane',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: t(115),
      updatedAt: t(215, 555000),
      submittedAt: t(215, 555000),
    },
    {
      // F13: Minimal eight-field-origin submitted profile
      uid: 'm2-drv-eight-field',
      name: 'Minimal Provisioning Driver',
      vehicleNumber: 'MH02OP8008',
      phone: '+919820011008',
      truckType: 'flatbed',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt: t(120),
      updatedAt: t(220, 666000),
      submittedAt: t(220, 666000),
    },
    {
      // Pilot pre-provisioned driver with well-typed operational fields
      uid: 'm2-drv-pilot-provisioned',
      name: 'Pilot Pre-Provisioned Driver',
      vehicleNumber: 'MH43QR9009',
      phone: '+919820011009',
      truckType: 'flatbed',
      verificationStatus: 'pending',
      isOnDuty: false,
      walletBalance: 50000,
      activeJobId: null,
      activeOfferId: null,
      dutySessionId: null,
      bannedUntil: null,
      strictMode: false,
      monthlyCancelCount: { month: '2026-10', count: 0 },
      workerReady: false,
      createdAt: t(125),
      updatedAt: t(225, 777000),
      submittedAt: t(225, 777000),
    },
  ];

  // Upload storage files and write documents for standard drivers
  for (const drv of standardDrivers) {
    const files = await uploadKycFiles(drv.uid);
    const docData = {
      ...drv,
      verificationDocs: {
        idPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${drv.uid}/id.jpg`,
        rcPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${drv.uid}/rc.jpg`,
        selfiePhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${drv.uid}/selfie.jpg`,
        submittedAt: drv.submittedAt,
      },
    };
    delete docData.submittedAt;
    await adminDb.collection('drivers').doc(drv.uid).set(docData);
    console.log(`  Driver seeded: ${drv.uid} (${drv.verificationStatus}) [gens: id=${files.id}, rc=${files.rc}, selfie=${files.selfie}]`);
  }

  // Missing file driver: only id.jpg and rc.jpg
  const missingFileUid = 'm2-drv-missing-file';
  await uploadKycFiles(missingFileUid, ['id.jpg', 'rc.jpg']);
  await adminDb.collection('drivers').doc(missingFileUid).set({
    uid: missingFileUid,
    name: 'Omkar MissingDoc',
    vehicleNumber: 'MH43ST1010',
    phone: '+919820011010',
    truckType: 'tochan',
    verificationStatus: 'pending',
    isOnDuty: false,
    createdAt: t(130),
    updatedAt: t(230, 888000),
    verificationDocs: {
      idPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${missingFileUid}/id.jpg`,
      rcPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${missingFileUid}/rc.jpg`,
      selfiePhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${missingFileUid}/selfie.jpg`,
      submittedAt: t(230, 888000),
    },
  });
  console.log(`  Driver seeded: ${missingFileUid} (missing selfie.jpg in bucket)`);

  // Invalid schema driver: blank name, missing vehicleNumber
  const invalidSchemaUid = 'm2-drv-invalid-schema';
  await uploadKycFiles(invalidSchemaUid);
  await adminDb.collection('drivers').doc(invalidSchemaUid).set({
    uid: invalidSchemaUid,
    name: '',
    vehicleNumber: null,
    phone: 'invalid-phone',
    truckType: 'invalid-truck',
    verificationStatus: 'pending',
    isOnDuty: false,
    createdAt: t(135),
    updatedAt: t(235, 999000),
    verificationDocs: {
      idPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${invalidSchemaUid}/id.jpg`,
      rcPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${invalidSchemaUid}/rc.jpg`,
      selfiePhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${invalidSchemaUid}/selfie.jpg`,
      submittedAt: t(235, 999000),
    },
  });
  console.log(`  Driver seeded: ${invalidSchemaUid} (malformed profile fields)`);

  // F11: At least 27 pending drivers to test 25+sentinel pagination (30 total)
  console.log('  Seeding 30 paginated pending drivers (with equal createdAt clusters)...');
  for (let i = 1; i <= 30; i++) {
    const numStr = String(i).padStart(2, '0');
    const pageUid = `m2-drv-page-${numStr}`;
    // Cluster createdAt in groups of 5 with equal timestamps to exercise tie-break
    const cluster = Math.floor(i / 5);
    const createdAt = t(300 + cluster * 10);
    const updatedAt = t(500 + i);

    await uploadKycFiles(pageUid);
    await adminDb.collection('drivers').doc(pageUid).set({
      uid: pageUid,
      name: `Queue Driver ${numStr}`,
      vehicleNumber: `MH46P${numStr}99`,
      phone: `+91982002${numStr}0`,
      truckType: i % 2 === 0 ? 'flatbed' : 'tochan',
      verificationStatus: 'pending',
      isOnDuty: false,
      createdAt,
      updatedAt,
      verificationDocs: {
        idPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${pageUid}/id.jpg`,
        rcPhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${pageUid}/rc.jpg`,
        selfiePhotoUrl: `gs://${BUCKET_NAME}/driver_verification/${pageUid}/selfie.jpg`,
        submittedAt: updatedAt,
      },
    });
  }
  console.log('  Seeded 30 paginated pending driver fixtures.');

  // 2. Seed Jobs Fixtures
  console.log('\n2. Seeding Live Jobs Fixtures...');

  // Active paid jobs: pending_offer, offered, accepted, in_progress
  const activeJobs = [
    {
      id: 'm2-job-pending-offer-1',
      status: 'pending_offer',
      towingCategory: 'flatbed',
      customerPhone: '+919988776655',
      pickupCoords: { latitude: 19.033, longitude: 73.0297 },
      destCoords: { latitude: 19.076, longitude: 72.8777 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 250000,
      dispatchGeneration: 1,
      dispatchRunId: 'run-pending-1',
      currentDispatchRunId: 'run-pending-1',
      operational_hold: false,
      createdAt: t(1000),
      updatedAt: t(1050),
    },
    {
      id: 'm2-job-offered-1',
      status: 'offered',
      towingCategory: 'pulling',
      customerPhone: '+919876500001',
      pickupCoords: { latitude: 19.04, longitude: 73.02 },
      destCoords: { latitude: 19.09, longitude: 72.89 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 180000,
      dispatchGeneration: 1,
      dispatchRunId: 'run-offered-1',
      currentDispatchRunId: 'run-offered-1',
      currentOfferId: 'm2-offer-1',
      offeredTo: 'm2-drv-pilot-provisioned',
      offerExpiresAt: t(1200),
      createdAt: t(980),
      updatedAt: t(1080),
    },
    {
      id: 'm2-job-accepted-1',
      status: 'accepted',
      towingCategory: 'flatbed',
      customerPhone: '+919876500002',
      pickupCoords: { latitude: 19.05, longitude: 73.03 },
      destCoords: { latitude: 19.10, longitude: 72.90 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 20000,
      estimatedFarePaise: 320000,
      dispatchGeneration: 1,
      dispatchRunId: 'run-accepted-1',
      currentDispatchRunId: 'run-accepted-1',
      assignedDriver: 'm2-drv-pilot-provisioned',
      acceptedAt: t(1020),
      createdAt: t(960),
      updatedAt: t(1020),
    },
    {
      id: 'm2-job-inprogress-1',
      status: 'in_progress',
      towingCategory: 'flatbed',
      customerPhone: '+919876500003',
      pickupCoords: { latitude: 19.06, longitude: 73.04 },
      destCoords: { latitude: 19.12, longitude: 72.92 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 20000,
      estimatedFarePaise: 350000,
      dispatchGeneration: 1,
      dispatchRunId: 'run-inprogress-1',
      currentDispatchRunId: 'run-inprogress-1',
      assignedDriver: 'm2-drv-pilot-provisioned',
      tripStartedAt: t(1040),
      createdAt: t(940),
      updatedAt: t(1040),
    },
    {
      id: 'm2-job-hold-1',
      status: 'pending_offer',
      towingCategory: 'tochan',
      customerPhone: '+919876500004',
      pickupCoords: { latitude: 19.07, longitude: 73.05 },
      destCoords: { latitude: 19.14, longitude: 72.94 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 200000,
      dispatchGeneration: 1,
      dispatchRunId: 'run-hold-1',
      currentDispatchRunId: 'run-hold-1',
      operational_hold: true,
      dispatchLastFailure: {
        code: 'GEOCODING_TIMEOUT',
        source: 'maps_client',
        retryable: true,
        occurredAt: t(1010),
      },
      createdAt: t(920),
      updatedAt: t(1010),
    },
    {
      id: 'm2-job-cancel-pending-1',
      status: 'accepted',
      towingCategory: 'flatbed',
      customerPhone: '+919876500005',
      pickupCoords: { latitude: 19.08, longitude: 73.06 },
      destCoords: { latitude: 19.15, longitude: 72.95 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 20000,
      estimatedFarePaise: 280000,
      dispatchGeneration: 1,
      currentDispatchRunId: 'run-cancel-1',
      assignedDriver: 'm2-drv-pilot-provisioned',
      customerCancellationPending: true,
      createdAt: t(900),
      updatedAt: t(1060),
    },
    {
      id: 'm2-job-live-terminal-1',
      status: 'accepted',
      towingCategory: 'flatbed',
      customerPhone: '+919876500006',
      pickupCoords: { latitude: 19.03, longitude: 73.01 },
      destCoords: { latitude: 19.08, longitude: 72.85 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 18000,
      estimatedFarePaise: 260000,
      dispatchGeneration: 1,
      currentDispatchRunId: 'run-terminal-1',
      assignedDriver: 'm2-drv-pilot-provisioned',
      createdAt: t(880),
      updatedAt: t(1050),
    },
  ];

  for (const job of activeJobs) {
    const { id, ...data } = job;
    await adminDb.collection('jobs').doc(id).set(data);
    console.log(`  Job seeded: ${id} (${data.status})`);
  }

  // Dispatch run subcollections for detail tests
  await adminDb.collection('jobs').doc('m2-job-offered-1').collection('dispatch_runs').doc('run-offered-1').set({
    jobId: 'm2-job-offered-1',
    dispatchGeneration: 1,
    status: 'offering',
    nextCandidateIndex: 1,
    candidateCount: 3,
    round: 1,
    rankingMode: 'eta_distance',
    candidates: [
      { driverUid: 'm2-drv-pilot-provisioned', etaSeconds: 300, distanceMeters: 2500, status: 'offered' },
      { driverUid: 'm2-drv-pending-race1', etaSeconds: 420, distanceMeters: 3800, status: 'eligible' },
      { driverUid: 'm2-drv-pending-race2', etaSeconds: 600, distanceMeters: 5200, status: 'eligible' },
    ],
    createdAt: t(1080),
    updatedAt: t(1080),
  });

  await adminDb.collection('jobs').doc('m2-job-offered-1').collection('offers').doc('m2-offer-1').set({
    jobId: 'm2-job-offered-1',
    dispatchGeneration: 1,
    candidateIndex: 0,
    offeredTo: 'm2-drv-pilot-provisioned',
    status: 'offered',
    expiresAt: t(1200),
    createdAt: t(1080),
  });

  // Awaiting Payment jobs (excluded from default paid view, included in awaiting_payment filter)
  const unpaidJobs = [
    {
      id: 'm2-job-unpaid-1',
      status: 'awaiting_payment',
      towingCategory: 'flatbed',
      customerPhone: '+919876511111',
      pickupCoords: { latitude: 19.01, longitude: 73.01 },
      destCoords: { latitude: 19.05, longitude: 72.85 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 210000,
      createdAt: t(1100),
      updatedAt: t(1100),
    },
    {
      id: 'm2-job-unpaid-2',
      status: 'awaiting_payment',
      towingCategory: 'tochan',
      customerPhone: '+919876511112',
      pickupCoords: { latitude: 19.02, longitude: 73.02 },
      destCoords: { latitude: 19.06, longitude: 72.86 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 190000,
      createdAt: t(1110),
      updatedAt: t(1110),
    },
  ];

  for (const job of unpaidJobs) {
    const { id, ...data } = job;
    await adminDb.collection('jobs').doc(id).set(data);
    console.log(`  Unpaid Job seeded: ${id} (awaiting_payment)`);
  }

  // Terminal jobs (excluded from default and awaiting_payment queries)
  const terminalJobs = [
    { id: 'm2-job-completed-1', status: 'completed' },
    { id: 'm2-job-cancelled-cust-1', status: 'cancelled_customer' },
    { id: 'm2-job-cancelled-sys-1', status: 'cancelled_system' },
    { id: 'm2-job-cancelled-drv-1', status: 'cancelled_driver' },
  ];

  for (const term of terminalJobs) {
    await adminDb.collection('jobs').doc(term.id).set({
      status: term.status,
      towingCategory: 'flatbed',
      customerPhone: '+919876599999',
      pickupCoords: { latitude: 19.01, longitude: 73.01 },
      destCoords: { latitude: 19.05, longitude: 72.85 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 220000,
      createdAt: t(700),
      updatedAt: t(800),
    });
    console.log(`  Terminal Job seeded: ${term.id} (${term.status})`);
  }

  // F11: 30 Paginated Active Jobs (with equal createdAt clusters)
  console.log('  Seeding 30 paginated active jobs (ordered by createdAt DESC)...');
  for (let i = 1; i <= 30; i++) {
    const numStr = String(i).padStart(2, '0');
    const jobId = `m2-job-page-${numStr}`;
    const cluster = Math.floor(i / 5);
    // Descending timestamps with duplicate clusters
    const createdAt = t(2000 - cluster * 10);
    const updatedAt = t(2100 + i);

    await adminDb.collection('jobs').doc(jobId).set({
      status: i % 3 === 0 ? 'accepted' : (i % 2 === 0 ? 'offered' : 'pending_offer'),
      towingCategory: i % 2 === 0 ? 'flatbed' : 'pulling',
      customerPhone: `+91987654${numStr}1`,
      pickupCoords: { latitude: 19.03 + i * 0.001, longitude: 73.02 + i * 0.001 },
      destCoords: { latitude: 19.08 + i * 0.001, longitude: 72.88 + i * 0.001 },
      bookingFeePaise: 49900,
      driverCommissionPaise: 15000,
      estimatedFarePaise: 200000 + i * 1000,
      createdAt,
      updatedAt,
    });
  }
  console.log('  Seeded 30 paginated active job fixtures.');

  console.log('\n=== All Phase 6 M2 Fixtures Successfully Seeded ===\n');
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith('seed-m2-emulator.mjs')) {
  seedM2Fixtures()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n[FATAL] Error seeding M2 fixtures:', err);
      process.exit(1);
    });
}
