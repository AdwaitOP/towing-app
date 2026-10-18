import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';

// Polyfill navigator.locks in jsdom environment for unit tests
if (typeof navigator !== 'undefined' && !navigator.locks) {
  const heldLocks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    value: {
      request: async (
        name: string,
        optionsOrCallback: unknown,
        maybeCallback?: (lock: unknown) => Promise<unknown>
      ) => {
        const callback =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (lock: unknown) => Promise<unknown>)
            : maybeCallback!;
        const prev = heldLocks.get(name) || Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        heldLocks.set(name, prev.then(() => next));
        await prev;
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          release();
        }
      },
    },
    configurable: true,
  });
}

// Polyfill crypto.randomUUID if absent in environment
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  let counter = 0;
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    configurable: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});
