import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAuthorizedOperationsSession,
  isOperationsSessionValid,
  SequenceTracker,
  type OperationsSessionScope,
} from '../operationsSession';
import * as AuthCoordinatorModule from '@/auth/authCoordinator';

describe('operationsSession Service', () => {
  const mockRuntime = {
    sessionId: 'session-m2-test',
    isCleanupOnly: false,
    auth: {
      currentUser: {
        uid: 'admin-uid-123',
      },
    },
  };

  const mockSnapshot = {
    status: 'AUTHORIZED_ADMIN' as const,
    canRenderProtected: true,
    serverProofVerified: true,
    isAdmin: true,
    sessionId: 'session-m2-test',
    bindingId: 42,
    generation: 1,
    user: {
      uid: 'admin-uid-123',
      email: 'admin@towmitra.test',
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an OperationsSessionScope when auth is fully authorized', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => mockSnapshot as any,
      getActiveRuntime: () => mockRuntime as any,
    } as any);

    const scope = getAuthorizedOperationsSession(mockSnapshot as any);
    expect(scope).not.toBeNull();
    expect(scope?.uid).toBe('admin-uid-123');
    expect(scope?.sessionId).toBe('session-m2-test');
    expect(scope?.bindingId).toBe(42);
    expect(scope?.generation).toBe(1);
    expect(scope?.runtime).toBe(mockRuntime);
  });

  it('returns null if status is not AUTHORIZED_ADMIN', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => ({ ...mockSnapshot, status: 'AUTHENTICATED_NON_ADMIN' }) as any,
      getActiveRuntime: () => mockRuntime as any,
    } as any);

    const scope = getAuthorizedOperationsSession({
      ...mockSnapshot,
      status: 'AUTHENTICATED_NON_ADMIN' as any,
    } as any);
    expect(scope).toBeNull();
  });

  it('returns null if canRenderProtected is false', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => ({ ...mockSnapshot, canRenderProtected: false }) as any,
      getActiveRuntime: () => mockRuntime as any,
    } as any);

    const scope = getAuthorizedOperationsSession({
      ...mockSnapshot,
      canRenderProtected: false,
    } as any);
    expect(scope).toBeNull();
  });

  it('returns null if serverProofVerified is false', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => ({ ...mockSnapshot, serverProofVerified: false }) as any,
      getActiveRuntime: () => mockRuntime as any,
    } as any);

    const scope = getAuthorizedOperationsSession({
      ...mockSnapshot,
      serverProofVerified: false,
    } as any);
    expect(scope).toBeNull();
  });

  it('returns null if runtime is cleanup-only', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => mockSnapshot as any,
      getActiveRuntime: () => ({ ...mockRuntime, isCleanupOnly: true }) as any,
    } as any);

    const scope = getAuthorizedOperationsSession(mockSnapshot as any);
    expect(scope).toBeNull();
  });

  it('isOperationsSessionValid validates matching and mismatching sessions', () => {
    vi.spyOn(AuthCoordinatorModule, 'getAuthCoordinator').mockReturnValue({
      getSnapshot: () => mockSnapshot as any,
      getActiveRuntime: () => mockRuntime as any,
    } as any);

    const validScope: OperationsSessionScope = {
      uid: 'admin-uid-123',
      sessionId: 'session-m2-test',
      bindingId: 42,
      generation: 1,
      runtime: mockRuntime as any,
    };

    expect(isOperationsSessionValid(validScope)).toBe(true);

    // UID mismatch
    expect(isOperationsSessionValid({ ...validScope, uid: 'other-uid' })).toBe(false);

    // SessionId mismatch
    expect(isOperationsSessionValid({ ...validScope, sessionId: 'other-session' })).toBe(false);

    // BindingId mismatch
    expect(isOperationsSessionValid({ ...validScope, bindingId: 99 })).toBe(false);
  });

  it('SequenceTracker monotonically increments and resets', () => {
    const tracker = new SequenceTracker();
    const seq1 = tracker.next();
    const seq2 = tracker.next();
    expect(seq2).toBeGreaterThan(seq1);

    expect(tracker.isCurrent(seq1)).toBe(false);
    expect(tracker.isCurrent(seq2)).toBe(true);

    tracker.reset();
    expect(tracker.isCurrent(seq2)).toBe(false);
  });
});
