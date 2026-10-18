import { connectAuthEmulator, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, type Functions } from 'firebase/functions';
import { connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

const REQUIRED_PROJECT_ID = 'demo-towmitra-admin';
const EXPECTED_REGION = 'asia-south1';

export class FatalConfigurationError extends Error {
  constructor(message: string) {
    super(`[Security Invariant Violation] ${message}`);
    this.name = 'FatalConfigurationError';
  }
}

function assertLoopbackHost(host: string, name: string): { hostname: string; port: number } {
  if (!host) {
    throw new FatalConfigurationError(`Missing required emulator host for ${name}`);
  }
  const parts = host.split(':');
  if (parts.length !== 2) {
    throw new FatalConfigurationError(`Invalid emulator host format for ${name}: "${host}". Expected "hostname:port".`);
  }
  const hostname = parts[0];
  const port = parseInt(parts[1], 10);
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new FatalConfigurationError(
      `Non-loopback emulator host detected for ${name}: "${hostname}". Only loopback ("127.0.0.1" or "localhost") is permitted in Phase 6 M1.`
    );
  }
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new FatalConfigurationError(`Invalid port for ${name}: "${parts[1]}".`);
  }
  return { hostname, port };
}

export function validateEmulatorEnvironment() {
  const isEmulator = import.meta.env.VITE_USE_FIREBASE_EMULATOR;
  if (isEmulator !== 'true') {
    throw new FatalConfigurationError(
      'VITE_USE_FIREBASE_EMULATOR must be set to "true". Phase 6 M1 does not permit live Firebase connections.'
    );
  }

  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  if (projectId !== REQUIRED_PROJECT_ID) {
    throw new FatalConfigurationError(
      `Unexpected Firebase project ID "${projectId}". Expected strictly "${REQUIRED_PROJECT_ID}". Do not access real or non-disposable projects.`
    );
  }

  const region = import.meta.env.VITE_FUNCTIONS_REGION || EXPECTED_REGION;
  if (region !== EXPECTED_REGION) {
    throw new FatalConfigurationError(
      `Unexpected backend functions region "${region}". Source-verified region is "${EXPECTED_REGION}".`
    );
  }

  const authHost = assertLoopbackHost(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST, 'Auth');
  const firestoreHost = assertLoopbackHost(import.meta.env.VITE_FIRESTORE_EMULATOR_HOST, 'Firestore');
  const functionsHost = assertLoopbackHost(import.meta.env.VITE_FUNCTIONS_EMULATOR_HOST, 'Functions');
  const storageHost = assertLoopbackHost(import.meta.env.VITE_STORAGE_EMULATOR_HOST, 'Storage');

  return { projectId, region, authHost, firestoreHost, functionsHost, storageHost };
}

// Validate environment immediately upon module evaluation
export const envConfig = validateEmulatorEnvironment();

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'fake-api-key-for-emulator',
  authDomain: `${REQUIRED_PROJECT_ID}.firebaseapp.com`,
  projectId: REQUIRED_PROJECT_ID,
  storageBucket: `${REQUIRED_PROJECT_ID}.appspot.com`,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789012',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789012:web:abcdef123456',
};

export const EMULATOR_CONFIG = {
  projectId: REQUIRED_PROJECT_ID,
  region: envConfig.region,
  ports: {
    auth: envConfig.authHost.port,
    firestore: envConfig.firestoreHost.port,
    functions: envConfig.functionsHost.port,
    storage: envConfig.storageHost.port,
  },
};

export function connectAuthToEmulator(auth: Auth) {
  connectAuthEmulator(auth, `http://${envConfig.authHost.hostname}:${envConfig.authHost.port}`, {
    disableWarnings: true,
  });
}

export function connectFirestoreToEmulator(db: Firestore) {
  connectFirestoreEmulator(db, envConfig.firestoreHost.hostname, envConfig.firestoreHost.port);
}

export function connectFunctionsToEmulator(functions: Functions) {
  connectFunctionsEmulator(functions, envConfig.functionsHost.hostname, envConfig.functionsHost.port);
}

export function connectStorageToEmulator(storage: FirebaseStorage) {
  connectStorageEmulator(storage, envConfig.storageHost.hostname, envConfig.storageHost.port);
}
