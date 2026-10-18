import type { Fence, Intent, SessionId, Ticket } from '@/types/auth';

export const FENCE_STORAGE_KEY = 'towmitra:demo-towmitra-admin:m1:selection:v1';
export const SHORT_LOCK_NAME = 'towmitra:demo-towmitra-admin:m1:selection';
export const LONG_LOCK_NAME = 'towmitra:demo-towmitra-admin:m1:mutation';

export class CoordinationUnavailableError extends Error {
  constructor(message: string) {
    super(`[Coordination Unavailable] ${message}`);
    this.name = 'CoordinationUnavailableError';
  }
}

export const DEFAULT_FENCE: Fence = {
  v: 1,
  latest: { id: 'init', kind: 'LOGOUT' },
  gate: 'SIGNED_OUT',
  sessionId: null,
};

export function isValidFence(raw: unknown): raw is Fence {
  if (!raw || typeof raw !== 'object') return false;
  const f = raw as Record<string, unknown>;
  if (f.v !== 1) return false;
  if (!f.latest || typeof f.latest !== 'object') return false;
  const latest = f.latest as Record<string, unknown>;
  if (typeof latest.id !== 'string' || !latest.id) return false;
  if (latest.kind !== 'LOGIN' && latest.kind !== 'LOGOUT') return false;
  if (f.gate !== 'CLOSED' && f.gate !== 'ACTIVE' && f.gate !== 'SIGNED_OUT') return false;

  if (f.gate === 'ACTIVE') {
    if (latest.kind !== 'LOGIN') return false;
    if (typeof f.sessionId !== 'string' || f.sessionId !== latest.id) return false;
  }
  if (f.gate === 'SIGNED_OUT') {
    if (f.sessionId !== null) return false;
  }
  if (f.gate === 'CLOSED') {
    if (f.sessionId !== null && typeof f.sessionId !== 'string') return false;
  }
  return true;
}

export function parseFence(rawJson: string | null): Fence {
  if (!rawJson) {
    return { ...DEFAULT_FENCE };
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (isValidFence(parsed)) {
      return parsed;
    }
  } catch {
    // Malformed JSON falls through to fail-closed
  }
  return {
    v: 1,
    latest: { id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'fail-closed', kind: 'LOGOUT' },
    gate: 'CLOSED',
    sessionId: null,
  };
}

/**
 * Raw non-locking fence read for non-mutating checks and wakeups.
 */
export function readFenceRaw(): Fence {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_FENCE };
    const raw = localStorage.getItem(FENCE_STORAGE_KEY);
    return parseFence(raw);
  } catch {
    return {
      v: 1,
      latest: { id: 'storage-inaccessible', kind: 'LOGOUT' },
      gate: 'CLOSED',
      sessionId: null,
    };
  }
}

/**
 * Executes a synchronous read/modify/write callback under the short selection Web Lock.
 * Never await network, the long lock, or an SDK promise inside the callback!
 */
export async function withFence<T>(callback: (fence: Fence) => T): Promise<T> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.locks ||
    typeof navigator.locks.request !== 'function'
  ) {
    throw new CoordinationUnavailableError('navigator.locks is not available in this environment.');
  }

  let result!: T;
  try {
    await navigator.locks.request(SHORT_LOCK_NAME, { mode: 'exclusive' }, async () => {
      let rawJson: string | null;
      try {
        rawJson = localStorage.getItem(FENCE_STORAGE_KEY);
      } catch (err) {
        throw new CoordinationUnavailableError(
          `localStorage read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const fence = parseFence(rawJson);
      const initialSerialized = JSON.stringify(fence);

      const callbackResult = callback(fence);

      // Verify callback did not return a Promise
      if (
        callbackResult &&
        typeof (callbackResult as unknown as { then?: unknown }).then === 'function'
      ) {
        throw new Error(
          'withFence callback must be synchronous; returning promises is forbidden to prevent holding the selection lock across async operations.'
        );
      }

      const postSerialized = JSON.stringify(fence);
      if (postSerialized !== initialSerialized) {
        if (!isValidFence(fence)) {
          throw new Error('Attempted to write an invalid Fence state');
        }
        try {
          localStorage.setItem(FENCE_STORAGE_KEY, postSerialized);
        } catch (err) {
          throw new CoordinationUnavailableError(
            `localStorage write failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      result = callbackResult;
    });
  } catch (err) {
    if (err instanceof CoordinationUnavailableError) throw err;
    throw new CoordinationUnavailableError(
      `Web Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return result;
}

/**
 * Executes an action under the short selection Web Lock that prepares a fence mutation
 * and returns an invocation plan.
 * The fence mutation is validated and committed to localStorage BEFORE the invocation
 * plan is executed. If localStorage write fails, the invocation is NEVER called.
 */
export async function executeUnderFence<T>(
  action: (fence: Fence) => { invoke: () => T } | null
): Promise<T | null> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.locks ||
    typeof navigator.locks.request !== 'function'
  ) {
    throw new CoordinationUnavailableError('navigator.locks is not available in this environment.');
  }

  let result: T | null = null;
  try {
    await navigator.locks.request(SHORT_LOCK_NAME, { mode: 'exclusive' }, async () => {
      let rawJson: string | null;
      try {
        rawJson = localStorage.getItem(FENCE_STORAGE_KEY);
      } catch (err) {
        throw new CoordinationUnavailableError(
          `localStorage read failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const fence = parseFence(rawJson);
      const initialSerialized = JSON.stringify(fence);

      const plan = action(fence);
      if (!plan) {
        result = null;
        return;
      }

      const postSerialized = JSON.stringify(fence);
      if (postSerialized !== initialSerialized) {
        if (!isValidFence(fence)) {
          throw new Error('Attempted to write an invalid Fence state');
        }
        try {
          localStorage.setItem(FENCE_STORAGE_KEY, postSerialized);
        } catch (err) {
          throw new CoordinationUnavailableError(
            `localStorage write failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Synchronously invoke only AFTER fence mutation is successfully committed to storage
      const invokedResult = plan.invoke();

      if (
        invokedResult &&
        typeof (invokedResult as unknown as { then?: unknown }).then === 'function'
      ) {
        throw new Error(
          'executeUnderFence invoke must be synchronous; returning promises directly is forbidden.'
        );
      }

      result = invokedResult;
    });
  } catch (err) {
    if (err instanceof CoordinationUnavailableError) throw err;
    throw new CoordinationUnavailableError(
      `Web Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return result;
}

/**
 * Atomically admits a new explicit intent under the short selection lock.
 * Sets gate to CLOSED, updates latest to the intent, and preserves previous sessionId
 * as a cleanup target.
 */
export async function admitIntent(intent: Intent): Promise<Fence> {
  return withFence((fence) => {
    fence.latest = intent;
    fence.gate = 'CLOSED';
    // sessionId retains previous.sessionId for target cleanup
    return { ...fence };
  });
}

/**
 * Checks if the current fence owns the expected ticket and optional target.
 */
export function ownsExpectedTicketAndTarget(
  fence: Fence,
  ticket: Ticket,
  targetSessionId?: SessionId | null
): boolean {
  if (fence.latest.id !== ticket) return false;
  if (targetSessionId !== undefined && fence.sessionId !== targetSessionId) return false;
  return true;
}

/**
 * Subscribes to shared-fence invalidation events:
 * localStorage 'storage' events, focus, pageshow, and visibilitychange.
 */
export function subscribeToFenceChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === FENCE_STORAGE_KEY) {
      callback();
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      callback();
    }
  };

  const onFocusOrPageShow = () => {
    callback();
  };

  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', onFocusOrPageShow);
  window.addEventListener('pageshow', onFocusOrPageShow);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', onFocusOrPageShow);
    window.removeEventListener('pageshow', onFocusOrPageShow);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
