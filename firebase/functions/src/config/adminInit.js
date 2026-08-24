'use strict';

/**
 * Firebase Admin SDK initialisation — single point of entry.
 *
 * Every Cloud Function file that needs Firestore, Storage, or Auth imports
 * from here (or from firebase-admin/firestore etc. after this module has
 * loaded). Calling admin.initializeApp() more than once in the same process
 * throws, so we gate on getApps().length.
 *
 * In the emulator the Admin SDK is automatically connected to the local
 * emulator suite via the FIREBASE_EMULATOR_HUB / FIRESTORE_EMULATOR_HOST
 * environment variables set by `firebase emulators:start`. No code change
 * is needed to switch between emulator and production.
 */

const { initializeApp, getApps } = require('firebase-admin/app');

if (getApps().length === 0) {
  initializeApp();
}

// Re-export nothing — callers import directly from 'firebase-admin/firestore',
// 'firebase-admin/storage', etc. after this module has been side-effect loaded
// (i.e., require('./config/adminInit') at the top of each function file).
