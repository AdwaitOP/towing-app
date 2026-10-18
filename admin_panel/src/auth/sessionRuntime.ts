import { initializeApp, getApps, deleteApp, type FirebaseApp } from 'firebase/app';
export { getApps } from 'firebase/app';
import {
  initializeAuth,
  getAuth,
  signInWithEmailAndPassword,
  inMemoryPersistence,
  indexedDBLocalPersistence,
  type Auth,
  type UserCredential,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getFunctions, type Functions } from 'firebase/functions';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import {
  firebaseConfig,
  EMULATOR_CONFIG,
  connectAuthToEmulator,
  connectFirestoreToEmulator,
  connectFunctionsToEmulator,
  connectStorageToEmulator,
} from '@/config/firebase';
import type { SessionId, Intent } from '@/types/auth';

export interface SessionRuntime {
  sessionId: SessionId;
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  storage: FirebaseStorage;
  isCleanupOnly?: boolean;
  installed: boolean;
}

export interface StagedAttempt {
  intent: Intent;
  app: FirebaseApp;
  auth: Auth;
  result: Promise<UserCredential>; // original public SDK promise, retained to settlement
  disposeAfterSettlement(): Promise<void>;
}

/**
 * Creates an isolated staging app using inMemoryPersistence for a login ticket.
 * Immediately connects to the Auth emulator and calls signInWithEmailAndPassword.
 */
export function createStagedAttempt(
  intent: Intent,
  email: string,
  password: string
): StagedAttempt {
  const appName = `towmitra-stage-${intent.id}`;
  const existing = getApps().find((a) => a.name === appName);
  const app = existing || initializeApp(firebaseConfig, appName);
  const auth = existing ? getAuth(app) : initializeAuth(app, { persistence: inMemoryPersistence });
  if (!existing) {
    connectAuthToEmulator(auth);
  }

  const result = signInWithEmailAndPassword(auth, email, password);

  const disposeAfterSettlement = async () => {
    try {
      await result;
    } catch {
      // ignore settlement failure
    }
    try {
      await deleteApp(app);
    } catch {
      // ignore
    }
  };

  return {
    intent,
    app,
    auth,
    result,
    disposeAfterSettlement,
  };
}

const canonicalRuntimes = new Map<SessionId, SessionRuntime>();

/**
 * Creates or attaches to a canonical session runtime with indexedDBLocalPersistence.
 * Connects all emulator clients once on initialization and awaits authStateReady()
 * outside the mutation lock with a strict 10-second presentation/readiness deadline.
 */
export async function createCanonicalSessionRuntime(
  sessionId: SessionId
): Promise<SessionRuntime> {
  const cached = canonicalRuntimes.get(sessionId);
  if (cached) {
    return cached;
  }

  const appName = `towmitra-session-${sessionId}`;
  const existing = getApps().find((a) => a.name === appName);
  let app: FirebaseApp;
  let auth: Auth;
  let db: Firestore;
  let functions: Functions;
  let storage: FirebaseStorage;

  if (existing) {
    app = existing;
    auth = getAuth(app);
    db = getFirestore(app);
    functions = getFunctions(app, EMULATOR_CONFIG.region);
    storage = getStorage(app);
  } else {
    app = initializeApp(firebaseConfig, appName);
    auth = initializeAuth(app, { persistence: indexedDBLocalPersistence });
    connectAuthToEmulator(auth);
    db = getFirestore(app);
    connectFirestoreToEmulator(db);
    functions = getFunctions(app, EMULATOR_CONFIG.region);
    connectFunctionsToEmulator(functions);
    storage = getStorage(app);
    connectStorageToEmulator(storage);
  }

  // 10-second presentation readiness deadline outside mutation lock
  await Promise.race([
    auth.authStateReady(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Auth readiness timeout for session ${sessionId}`)), 10000)
    ),
  ]);

  const runtime: SessionRuntime = {
    sessionId,
    app,
    auth,
    db,
    functions,
    storage,
    installed: false,
  };
  canonicalRuntimes.set(sessionId, runtime);
  return runtime;
}

/**
 * Creates a cleanup-only session runtime for CLOSED startup where an un-cleared target
 * session needs to be signed out. Uses inMemoryPersistence so it never restores an old user,
 * then can select indexedDB and call signOut under the mutation lock.
 */
export async function createCleanupRuntime(
  sessionId: SessionId
): Promise<SessionRuntime> {
  const appName = `towmitra-session-${sessionId}`;
  const existing = getApps().find((a) => a.name === appName);
  let app: FirebaseApp;
  let auth: Auth;
  let db: Firestore;
  let functions: Functions;
  let storage: FirebaseStorage;

  if (existing) {
    app = existing;
    auth = getAuth(app);
    db = getFirestore(app);
    functions = getFunctions(app, EMULATOR_CONFIG.region);
    storage = getStorage(app);
  } else {
    app = initializeApp(firebaseConfig, appName);
    auth = initializeAuth(app, { persistence: inMemoryPersistence });
    connectAuthToEmulator(auth);
    db = getFirestore(app);
    connectFirestoreToEmulator(db);
    functions = getFunctions(app, EMULATOR_CONFIG.region);
    connectFunctionsToEmulator(functions);
    storage = getStorage(app);
    connectStorageToEmulator(storage);
  }

  await Promise.race([
    auth.authStateReady(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Cleanup auth readiness timeout for session ${sessionId}`)), 10000)
    ),
  ]);

  return {
    sessionId,
    app,
    auth,
    db,
    functions,
    storage,
    isCleanupOnly: true,
    installed: false,
  };
}

export async function disposeSessionRuntime(runtime: SessionRuntime): Promise<void> {
  canonicalRuntimes.delete(runtime.sessionId);
  try {
    await deleteApp(runtime.app);
  } catch {
    // ignore
  }
}
