import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { AuthProvider, useAuth } from '../AuthContext';
import { AuthCoordinator } from '@/auth/authCoordinator';
import type { User, IdTokenResult } from 'firebase/auth';
import type { SessionRuntime, StagedAttempt } from '@/auth/sessionRuntime';
import type { Intent } from '@/types/auth';

// Mock dependencies
const mockOnIdTokenChanged = vi.fn();
const mockSignInWithEmailAndPassword = vi.fn();
const mockSignOut = vi.fn();

vi.mock('firebase/auth', () => ({
  onIdTokenChanged: (...args: unknown[]) => mockOnIdTokenChanged(...args),
  signInWithEmailAndPassword: (...args: unknown[]) => mockSignInWithEmailAndPassword(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  setPersistence: vi.fn().mockResolvedValue(undefined),
  updateCurrentUser: vi.fn().mockResolvedValue(undefined),
  indexedDBLocalPersistence: {},
  inMemoryPersistence: {},
}));

const mockRuntimeAuth = {
  currentUser: null as User | null,
  authStateReady: vi.fn().mockResolvedValue(undefined),
};

const mockRuntime: SessionRuntime = {
  sessionId: 'test-session-001',
  app: {} as any,
  auth: mockRuntimeAuth as any,
  db: {} as any,
  functions: {} as any,
  storage: {} as any,
  installed: false,
};

vi.mock('@/auth/sessionRuntime', () => ({
  createStagedAttempt: (intent: Intent, email: string, password: string): StagedAttempt => {
    const result = mockSignInWithEmailAndPassword({}, email, password);
    return {
      intent,
      app: {} as any,
      auth: {} as any,
      result,
      disposeAfterSettlement: vi.fn().mockResolvedValue(undefined),
    };
  },
  createCanonicalSessionRuntime: vi.fn().mockImplementation(async (sessionId: string) => {
    mockRuntime.sessionId = sessionId;
    return mockRuntime;
  }),
  createCleanupRuntime: vi.fn().mockImplementation(async (sessionId: string) => {
    mockRuntime.sessionId = sessionId;
    return mockRuntime;
  }),
  disposeSessionRuntime: vi.fn().mockResolvedValue(undefined),
}));

const mockVerifyServerAuthoritativeProof = vi.fn();
vi.mock('@/services/adminAuthorization', () => ({
  evaluateAdminClaim: (claims: Record<string, unknown> | null | undefined) => claims?.admin === true,
  verifyServerAuthoritativeProof: () => mockVerifyServerAuthoritativeProof(),
}));

function deferred<T = unknown>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const createMockUser = (
  uid: string,
  getIdTokenResult: (force?: boolean) => Promise<Partial<IdTokenResult>> = async () => ({ claims: { admin: true } }),
  email?: string
): User => ({
  uid,
  email: email || (uid.startsWith('admin') ? 'admin@towmitra.test' : `${uid}@towmitra.test`),
  getIdTokenResult: getIdTokenResult as unknown as User['getIdTokenResult'],
} as unknown as User);

describe('AuthProvider & AuthContext Lifecycle Hardening', () => {
  let tokenCallback: ((user: User | null) => Promise<void>) | null = null;
  let capturedContext: ReturnType<typeof useAuth> | null = null;
  let testCoordinator: AuthCoordinator | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyServerAuthoritativeProof.mockResolvedValue({ verified: true });
    mockSignOut.mockResolvedValue(undefined);
    mockRuntimeAuth.currentUser = null;

    mockOnIdTokenChanged.mockImplementation((_auth, cb) => {
      tokenCallback = cb;
      return () => {
        tokenCallback = null;
      };
    });

    // Seed localStorage with valid ACTIVE session for coordinator startup
    localStorage.setItem(
      'towmitra:demo-towmitra-admin:m1:selection:v1',
      JSON.stringify({
        v: 1,
        latest: { id: 'test-session-001', kind: 'LOGIN' },
        gate: 'ACTIVE',
        sessionId: 'test-session-001',
      })
    );
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    if (testCoordinator) {
      testCoordinator.stop();
      testCoordinator = null;
    }
  });

  const setup = async () => {
    testCoordinator = new AuthCoordinator();
    function Consumer() {
      capturedContext = useAuth();
      return <div data-testid="status">{capturedContext.status}</div>;
    }

    await act(async () => {
      render(
        <AuthProvider coordinator={testCoordinator}>
          <Consumer />
        </AuthProvider>
      );
    });
  };

  it('M1-K: registers onIdTokenChanged observer on mount', async () => {
    await setup();
    expect(mockOnIdTokenChanged).toHaveBeenCalledTimes(1);
    expect(tokenCallback).toBeTypeOf('function');
  });

  it('M1-F/I: forces fresh claims (forceRefresh = true) on initial user validation (D2)', async () => {
    await setup();
    const flags: boolean[] = [];
    const mockUser = createMockUser('admin1', async (force) => {
      flags.push(Boolean(force));
      return { claims: { admin: force ? false : true } };
    });
    mockRuntimeAuth.currentUser = mockUser;

    await act(async () => {
      await tokenCallback!(mockUser);
    });

    expect(flags[0]).toBe(true);
    expect(capturedContext?.status).toBe('ACCESS_DENIED');
  });

  it('M1-I/K: pending manual refresh immediately suppresses verified access (D5)', async () => {
    await setup();
    const mockUser = createMockUser('admin2');
    mockRuntimeAuth.currentUser = mockUser;

    await act(async () => {
      await tokenCallback!(mockUser);
    });
    expect(capturedContext?.status).toBe('AUTHORIZED_ADMIN');
    expect(capturedContext?.serverProofVerified).toBe(true);

    const hold = deferred<Partial<IdTokenResult>>();
    (mockUser.getIdTokenResult as unknown) = () => hold.promise;

    let pending: Promise<void>;
    await act(async () => {
      pending = capturedContext!.refreshAuthorization();
      await Promise.resolve();
    });

    // While refresh is pending, status must NOT be AUTHORIZED_ADMIN
    expect(capturedContext?.status).not.toBe('AUTHORIZED_ADMIN');
    expect(capturedContext?.serverProofVerified).toBe(false);

    await act(async () => {
      hold.resolve({ claims: { admin: true } });
      await pending;
    });

    expect(capturedContext?.status).toBe('AUTHORIZED_ADMIN');
    expect(capturedContext?.serverProofVerified).toBe(true);
  });

  it('M1-K: forced token-refresh failure clears verified access and sets ERROR (D5, D6)', async () => {
    await setup();
    const mockUser = createMockUser('admin3');
    mockRuntimeAuth.currentUser = mockUser;

    await act(async () => {
      await tokenCallback!(mockUser);
    });
    expect(capturedContext?.status).toBe('AUTHORIZED_ADMIN');

    (mockUser.getIdTokenResult as unknown) = async () => {
      throw new Error('Auth emulator network failure');
    };

    await act(async () => {
      await capturedContext!.refreshAuthorization();
    });

    expect(capturedContext?.status).toBe('ERROR');
    expect(capturedContext?.serverProofVerified).toBe(false);
  });

  it('M1-K/L: retryVerification enforces fresh token (forceRefresh = true) (D6)', async () => {
    await setup();
    const flags: boolean[] = [];
    const mockUser = createMockUser('admin4', async (force) => {
      flags.push(Boolean(force));
      if (force) throw new Error('Auth emulator unavailable');
      return { claims: { admin: true } };
    });
    mockRuntimeAuth.currentUser = mockUser;

    await act(async () => {
      await tokenCallback!(mockUser);
    });

    await act(async () => {
      await capturedContext!.refreshAuthorization();
    });
    expect(capturedContext?.status).toBe('ERROR');

    await act(async () => {
      await capturedContext!.retryVerification();
    });

    // Retry must force refresh, not reuse cached claims
    expect(flags[flags.length - 1]).toBe(true);
    expect(capturedContext?.status).not.toBe('AUTHORIZED_ADMIN');
  });

  it('M1-J: delayed login callback arriving after logout cannot reauthorize (D3)', async () => {
    await setup();
    const loginHold = deferred<{ user: User }>();
    mockSignInWithEmailAndPassword.mockReturnValue(loginHold.promise);

    const mockAdmin = createMockUser('admin-delayed');

    let pendingLogin: Promise<any>;
    await act(async () => {
      pendingLogin = capturedContext!.signIn('admin@towmitra.test', 'AdminPassword123!');
      await Promise.resolve();
    });

    // User signs out before login completes and SDK emits null event
    await act(async () => {
      await capturedContext!.signOutUser();
      if (tokenCallback) await tokenCallback(null);
    });
    expect(capturedContext?.status).toBe('UNAUTHENTICATED');

    // Late login resolves and SDK emits token change
    await act(async () => {
      loginHold.resolve({ user: mockAdmin });
      if (tokenCallback) await tokenCallback(mockAdmin);
      await pendingLogin;
    });

    // Session must remain unauthenticated
    expect(capturedContext?.status).toBe('UNAUTHENTICATED');
    expect(capturedContext?.user).toBeNull();
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('D3: cross-tab null event does not erase pending login cancellation', async () => {
    await setup();
    const loginHold = deferred<{ user: User }>();
    mockSignInWithEmailAndPassword.mockReturnValue(loginHold.promise);
    const mockAdmin = createMockUser('admin-crosstab');

    let pendingLogin: Promise<any>;
    await act(async () => {
      pendingLogin = capturedContext!.signIn('admin@towmitra.test', 'AdminPassword123!');
      await Promise.resolve();
    });

    // Cross-tab logout occurs by writing CLOSED fence with LOGOUT intent
    localStorage.setItem(
      'towmitra:demo-towmitra-admin:m1:selection:v1',
      JSON.stringify({
        v: 1,
        latest: { id: 'crosstab-logout', kind: 'LOGOUT' },
        gate: 'CLOSED',
        sessionId: 'test-session-001',
      })
    );

    // SDK receives null event from another tab
    await act(async () => {
      if (tokenCallback) await tokenCallback(null);
    });
    expect(capturedContext?.status).toBe('UNAUTHENTICATED');

    // Held login completes late
    await act(async () => {
      loginHold.resolve({ user: mockAdmin });
      if (tokenCallback) await tokenCallback(mockAdmin);
      await pendingLogin;
    });

    expect(capturedContext?.status).toBe('UNAUTHENTICATED');
    expect(capturedContext?.user).toBeNull();
  });

  it('M1-J/L: signOutUser failure enters ERROR status, retains error message and clears server proof (D7)', async () => {
    await setup();
    const mockAdmin = createMockUser('admin-logout-err');
    mockRuntimeAuth.currentUser = mockAdmin;

    await act(async () => {
      await tokenCallback!(mockAdmin);
    });
    expect(capturedContext?.status).toBe('AUTHORIZED_ADMIN');

    mockSignOut.mockRejectedValueOnce(new Error('Persistence removal failed'));

    let caughtError: unknown;
    await act(async () => {
      try {
        await capturedContext!.signOutUser();
      } catch (err) {
        caughtError = err;
      }
    });

    expect(caughtError).toBeDefined();
    expect(capturedContext?.status).toBe('ERROR');
    expect(capturedContext?.errorMessage).toContain('Persistence removal failed');
    expect(capturedContext?.serverProofVerified).toBe(false);
  });

  it('M1-F/G: server-side permission denial fails closed (D1)', async () => {
    await setup();
    mockVerifyServerAuthoritativeProof.mockResolvedValueOnce({
      verified: false,
      code: 'permission-denied',
    });

    const mockAdmin = createMockUser('admin-perm-denied');
    mockRuntimeAuth.currentUser = mockAdmin;

    await act(async () => {
      await tokenCallback!(mockAdmin);
    });

    expect(capturedContext?.status).toBe('ACCESS_DENIED');
    expect(capturedContext?.serverProofVerified).toBe(false);
  });
});
