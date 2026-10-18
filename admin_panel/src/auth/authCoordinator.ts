import {
  setPersistence,
  updateCurrentUser,
  signOut,
  onIdTokenChanged,
  indexedDBLocalPersistence,
  type User,
  type IdTokenResult,
} from 'firebase/auth';
import type {
  Ticket,
  SessionId,
  Intent,
  LoginOutcome,
  LogoutTarget,
  AuthSnapshot,
  CoordinatorStatus,
} from '@/types/auth';
import {
  withFence,
  executeUnderFence,
  admitIntent,
  readFenceRaw,
  subscribeToFenceChanges,
  LONG_LOCK_NAME,
  CoordinationUnavailableError,
} from '@/auth/sessionFence';
import {
  createStagedAttempt,
  createCanonicalSessionRuntime,
  createCleanupRuntime,
  type SessionRuntime,
  type StagedAttempt,
} from '@/auth/sessionRuntime';
import { evaluateAdminClaim, verifyServerAuthoritativeProof, type ProofVerificationResult } from '@/services/adminAuthorization';

interface RegisteredOperation {
  ticket: Ticket;
  target?: LogoutTarget;
  promise: Promise<unknown>;
  invokedAt: number;
}

const operationRegistry = new Map<string, RegisteredOperation>();

export function registerOriginalPromise(
  ticket: Ticket,
  target: LogoutTarget | undefined,
  promise: Promise<unknown>
): void {
  operationRegistry.set(ticket, {
    ticket,
    target,
    promise,
    invokedAt: Date.now(),
  });
}

export function getRegisteredPromise(ticket: Ticket): Promise<unknown> | undefined {
  return operationRegistry.get(ticket)?.promise;
}

async function withMutationLock<T>(action: () => Promise<T>): Promise<T> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.locks ||
    typeof navigator.locks.request !== 'function'
  ) {
    throw new CoordinationUnavailableError('navigator.locks is not available in this environment.');
  }

  let result!: T;
  await navigator.locks.request(LONG_LOCK_NAME, { mode: 'exclusive' }, async () => {
    result = await action();
  });
  return result;
}

export class AuthCoordinator {
  private status: CoordinatorStatus = 'INITIALIZING';
  private user: User | null = null;
  private tokenResult: IdTokenResult | null = null;
  private isAdmin = false;
  private serverProofVerified = false;
  private denialReason: string | null = null;
  private errorMessage: string | null = null;
  private isRefreshing = false;
  private validationId = 0;
  private sessionId: SessionId | null = null;
  private intentId: Ticket | null = null;
  private bindingId = 0;
  private canRenderProtected = false;
  private error: AuthSnapshot['error'] = null;

  private activeRuntime: SessionRuntime | null = null;
  private activeStagedAttempts = new Map<Ticket, StagedAttempt>();
  private unsubscribeTokenObserver: (() => void) | null = null;
  private unsubscribeFenceListener: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private isStarted = false;
  private isStopped = false;
  private activeValidationPromise: Promise<void> | null = null;
  private activeValidationUid: string | null = null;
  private activeValidationBindingId: number | null = null;
  private activeValidationSessionId: SessionId | null = null;
  private verificationErrorLatch: {
    owner: Ticket | null;
    validationId: number;
    uid: string;
  } | null = null;
  private tokenInputGeneration = 0;
  private activeValidationPhase: 'IDLE' | 'FRESH_TOKEN' | 'SERVER_PROOF' | 'FINAL_CHECK' = 'IDLE';

  public getSnapshot(): AuthSnapshot {
    return {
      status: this.status,
      user: this.user,
      tokenResult: this.tokenResult,
      isAdmin: this.isAdmin,
      serverProofVerified: this.serverProofVerified,
      denialReason: this.denialReason,
      errorMessage: this.errorMessage,
      isRefreshing: this.isRefreshing,
      generation: this.validationId,
      sessionId: this.sessionId,
      intentId: this.intentId,
      bindingId: this.bindingId,
      canRenderProtected: this.canRenderProtected,
      error: this.error,
    };
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    }
  }

  public async start(): Promise<void> {
    if (this.isStarted || this.isStopped) return;
    this.isStarted = true;

    // Install cross-tab and storage fence listeners before evaluating local auth
    this.unsubscribeFenceListener = subscribeToFenceChanges(() => {
      this.handleFenceWakeup().catch(() => {});
    });

    await this.evaluateInitialFence();
  }

  public stop(): void {
    this.isStopped = true;
    if (this.unsubscribeTokenObserver) {
      this.unsubscribeTokenObserver();
      this.unsubscribeTokenObserver = null;
    }
    if (this.unsubscribeFenceListener) {
      this.unsubscribeFenceListener();
      this.unsubscribeFenceListener = null;
    }
    this.listeners.clear();
  }

  public getActiveRuntime(): SessionRuntime | null {
    if (this.status === 'UNAUTHENTICATED' || !this.sessionId) {
      return null;
    }
    return this.activeRuntime;
  }

  private async evaluateInitialFence(): Promise<void> {
    try {
      const fence = await withFence((f) => ({ ...f }));
      if (fence.gate === 'ACTIVE' && fence.sessionId) {
        await this.attachToCanonicalSession(fence.sessionId, fence.latest.id);
      } else if (fence.gate === 'CLOSED') {
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        this.user = null;
        this.tokenResult = null;
        if (fence.sessionId) {
          this.status = 'ERROR';
          this.sessionId = fence.sessionId;
          this.intentId = fence.latest.id;
          this.errorMessage =
            'Previous session sign-out was interrupted or failed to clear storage cleanly. You may retry signing out to clear stored credentials, or sign in as a different user.';
          this.error = {
            kind: 'LOGOUT',
            owner: fence.latest.id,
            logoutTarget: { fenceIntent: fence.latest.id, sessionId: fence.sessionId },
          };
        } else {
          this.status = 'UNAUTHENTICATED';
          this.sessionId = null;
          this.intentId = null;
          this.error = null;
          this.errorMessage = null;
        }
        this.notify();
      } else {
        this.status = 'UNAUTHENTICATED';
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        this.user = null;
        this.tokenResult = null;
        this.sessionId = null;
        this.intentId = null;
        this.notify();
      }
    } catch (err: unknown) {
      this.status = 'ERROR';
      this.canRenderProtected = false;
      this.serverProofVerified = false;
      this.errorMessage =
        err instanceof Error ? err.message : 'Failed to evaluate authentication coordination fence.';
      this.error = {
        kind: 'COORDINATION',
        owner: null,
      };
      this.notify();
    }
  }

  private async handleFenceWakeup(): Promise<void> {
    if (this.isStopped) return;
    const rawFence = readFenceRaw();

    if (rawFence.gate === 'ACTIVE' && rawFence.sessionId) {
      if (this.sessionId !== rawFence.sessionId || !this.activeRuntime) {
        await this.attachToCanonicalSession(rawFence.sessionId, rawFence.latest.id);
      }
    } else if (rawFence.gate === 'CLOSED') {
      // Invalidate protected access immediately
      this.canRenderProtected = false;
      this.serverProofVerified = false;
      if (
        this.status !== 'STAGING' &&
        this.status !== 'WAITING_FOR_SESSION' &&
        this.status !== 'COMMITTING' &&
        this.status !== 'SIGNING_OUT' &&
        this.status !== 'ERROR'
      ) {
        if (rawFence.latest?.kind === 'LOGIN') {
          this.status = 'WAITING_FOR_SESSION';
        } else if (rawFence.latest?.kind === 'LOGOUT') {
          this.status = 'SIGNING_OUT';
        } else {
          this.status = 'UNAUTHENTICATED';
        }
      }
      this.notify();
    } else if (rawFence.gate === 'SIGNED_OUT') {
      this.canRenderProtected = false;
      this.serverProofVerified = false;
      this.status = 'UNAUTHENTICATED';
      this.user = null;
      this.tokenResult = null;
      this.sessionId = null;
      this.intentId = null;
      if (this.unsubscribeTokenObserver) {
        this.unsubscribeTokenObserver();
        this.unsubscribeTokenObserver = null;
      }
      this.activeRuntime = null;
      this.notify();
    }
  }

  private async attachToCanonicalSession(
    targetSessionId: SessionId,
    loginTicket: Ticket
  ): Promise<boolean> {
    let currentBinding = 0;
    let oldObserver: (() => void) | null = null;
    let admitted = false;

    await withFence((f) => {
      if (this.isStopped) return;
      if (f.gate !== 'ACTIVE' || f.sessionId !== targetSessionId) return;
      if (loginTicket && f.latest.id !== loginTicket) return;

      this.bindingId += 1;
      currentBinding = this.bindingId;
      admitted = true;

      oldObserver = this.unsubscribeTokenObserver;
      this.unsubscribeTokenObserver = null;

      this.status = 'VERIFYING_AUTHORIZATION';
      this.canRenderProtected = false;
      this.serverProofVerified = false;
      this.sessionId = targetSessionId;
      this.intentId = loginTicket;
    });

    if (!admitted) {
      return false;
    }

    const cleanupObserver = oldObserver as (() => void) | null;
    if (cleanupObserver) {
      try {
        cleanupObserver();
      } catch (err: unknown) {
        void err;
      }
    }

    this.notify();

    try {
      const runtime = await createCanonicalSessionRuntime(targetSessionId);
      let joined = false;
      await withFence((f) => {
        if (this.bindingId !== currentBinding || this.isStopped) return;
        if (f.gate !== 'ACTIVE' || f.sessionId !== targetSessionId) return;
        if (loginTicket && f.latest.id !== loginTicket) return;
        joined = true;
      });
      const currentFence = readFenceRaw();
      if (
        !joined ||
        this.bindingId !== currentBinding ||
        this.isStopped ||
        this.sessionId !== targetSessionId ||
        (loginTicket && this.intentId !== loginTicket) ||
        currentFence.gate !== 'ACTIVE' ||
        currentFence.sessionId !== targetSessionId ||
        (loginTicket && currentFence.latest.id !== loginTicket)
      ) {
        return false;
      }

      this.activeRuntime = runtime;

      // Subscribe to onIdTokenChanged
      this.unsubscribeTokenObserver = onIdTokenChanged(runtime.auth, (currentUser) => {
        this.handleTokenEvent(currentUser, runtime, currentBinding).catch(() => {});
      });

      const initialUser = runtime.auth.currentUser;
      if (!initialUser) {
        let unauth = false;
        await withFence((f) => {
          if (this.bindingId !== currentBinding || this.isStopped) return;
          if (f.sessionId !== targetSessionId) return;
          if (loginTicket && f.latest.id !== loginTicket) return;
          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
          this.canRenderProtected = false;
          unauth = true;
        });
        if (unauth) {
          this.notify();
        }
        return true;
      }

      await this.runValidationPipeline(runtime, initialUser, currentBinding, true);
      return true;
    } catch (err: unknown) {
      let owned = false;
      await withFence((f) => {
        if (this.bindingId !== currentBinding || this.isStopped) return;
        if (f.sessionId !== targetSessionId) return;
        if (loginTicket && f.latest.id !== loginTicket) return;

        owned = true;
        this.status = 'ERROR';
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        this.errorMessage =
          err instanceof Error ? err.message : 'Failed to attach to canonical session runtime.';
        this.error = {
          kind: 'VERIFICATION',
          owner: loginTicket,
        };
      });
      if (owned) {
        this.notify();
      }
      return false;
    }
  }

  private async handleTokenEvent(
    currentUser: User | null,
    runtime: SessionRuntime,
    bindingId: number
  ): Promise<void> {
    if (this.isStopped || this.bindingId !== bindingId) return;

    if (!currentUser) {
      const capturedBindingId = bindingId;
      const capturedTicket = this.intentId;

      let accepted = false;
      await withFence((f) => {
        if (this.isStopped) return;
        if (this.bindingId !== capturedBindingId) return;
        if (this.activeRuntime !== runtime) return;
        if (runtime.auth.currentUser !== null) return;
        if (this.sessionId !== runtime.sessionId) return;
        if (f.sessionId !== runtime.sessionId) return;

        // S1: If another login intent (e.g. B) has admitted, null from session A must NOT publish over B!
        if (f.gate === 'CLOSED' && f.latest.kind === 'LOGIN' && f.latest.id !== capturedTicket) {
          return;
        }

        // S1: If this coordinator is currently staging, waiting, or committing a new login,
        // an old null event must not overwrite the new login in progress
        if (
          (this.status === 'STAGING' ||
            this.status === 'WAITING_FOR_SESSION' ||
            this.status === 'COMMITTING') &&
          f.latest.kind === 'LOGIN'
        ) {
          return;
        }

        if (f.gate === 'ACTIVE') {
          f.gate = 'CLOSED';
          // retain sessionId as cleanup target
        }

        // Null event invalidates proof
        this.canRenderProtected = false;
        this.serverProofVerified = false;

        accepted = true;
        if (this.status !== 'SIGNING_OUT' && this.status !== 'ERROR') {
          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
        }
      });

      if (accepted) {
        this.notify();
      }
      return;
    }

    if (!this.activeRuntime || this.activeRuntime !== runtime) return;

    // In CLOSED or SIGNED_OUT, callbacks are observations only and must never initiate verification.
    const fence = readFenceRaw();
    if (fence.gate !== 'ACTIVE' || fence.sessionId !== this.sessionId) {
      return;
    }

    const isNewOrReplacedUser =
      (!this.user && this.activeValidationUid !== currentUser.uid) ||
      (this.user !== null && this.user.uid !== currentUser.uid);

    // If an error is latched for this session/user, ordinary non-forced token events cannot clear it
    if (this.verificationErrorLatch) {
      if (
        (this.verificationErrorLatch.owner === this.sessionId ||
          this.verificationErrorLatch.owner === this.intentId) &&
        (this.verificationErrorLatch.uid === currentUser.uid || !isNewOrReplacedUser)
      ) {
        return;
      }
    }

    this.tokenInputGeneration += 1;

    if (
      this.activeValidationPromise &&
      this.activeValidationUid === currentUser.uid &&
      this.activeValidationBindingId === bindingId &&
      this.activeValidationSessionId === runtime.sessionId
    ) {
      if (this.activeValidationPhase === 'FRESH_TOKEN') {
        return;
      }
      return;
    }

    await this.runValidationPipeline(
      this.activeRuntime,
      currentUser,
      bindingId,
      isNewOrReplacedUser
    );
  }

  private async runValidationPipeline(
    runtime: SessionRuntime,
    targetUser: User,
    bindingId: number,
    forceRefresh: boolean
  ): Promise<void> {
    if (
      this.activeValidationPromise &&
      this.activeValidationUid === targetUser.uid &&
      this.activeValidationBindingId === bindingId &&
      this.activeValidationSessionId === runtime.sessionId
    ) {
      return this.activeValidationPromise;
    }

    // G2: Latched verification errors cannot be cleared or re-verified by automatic non-forced jobs
    if (
      this.verificationErrorLatch &&
      (this.verificationErrorLatch.owner === runtime.sessionId ||
        this.verificationErrorLatch.owner === this.intentId) &&
      !forceRefresh
    ) {
      return;
    }

    let lastDrainedGen = this.tokenInputGeneration;

    const validationTask = (async () => {
      this.activeValidationUid = targetUser.uid;
      this.activeValidationBindingId = bindingId;
      this.activeValidationSessionId = runtime.sessionId;
      this.validationId += 1;
      const currentValidationId = this.validationId;
      const capturedSessionId = runtime.sessionId;
      const capturedTicket = this.intentId;
      const capturedUid = targetUser.uid;

      // S3 / G2: Guard entry state assignment under fence
      let verifyingPublished = false;
      await withFence((f) => {
        if (this.isStopped) return;
        if (this.bindingId !== bindingId) return;
        if (this.validationId !== currentValidationId) return;
        if (!this.activeRuntime || this.activeRuntime !== runtime) return;
        if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return;

        if (f.gate !== 'ACTIVE') return;
        if (f.latest.kind !== 'LOGIN') return;
        if (f.sessionId !== capturedSessionId) return;
        if (capturedTicket && f.latest.id !== capturedTicket) return;

        this.status = 'VERIFYING_AUTHORIZATION';
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        verifyingPublished = true;
      });

      if (!verifyingPublished) {
        return;
      }
      this.notify();

      const checkPublicationPredicate = async (): Promise<boolean> => {
        if (this.isStopped) return false;
        if (this.bindingId !== bindingId) return false;
        if (this.validationId !== currentValidationId) return false;
        if (!this.activeRuntime || this.activeRuntime !== runtime) return false;
        if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return false;

        const fence = await withFence((f) => ({ ...f }));
        if (fence.gate !== 'ACTIVE') return false;
        if (fence.latest.kind !== 'LOGIN') return false;
        if (fence.sessionId !== capturedSessionId) return false;
        if (capturedTicket && fence.latest.id !== capturedTicket) return false;

        return true;
      };

      try {
        // Phase 1: Fresh claims
        this.activeValidationPhase = 'FRESH_TOKEN';
        const readGeneration = this.tokenInputGeneration;
        const initialTokenResult = await targetUser.getIdTokenResult(forceRefresh);

        if (!(await checkPublicationPredicate())) {
          return;
        }

        const currentTokenResult = initialTokenResult;
        let capturedProofToken = '';

        const hasAdminClaim = evaluateAdminClaim(currentTokenResult.claims);
        if (!hasAdminClaim) {
          // G1: Check if newer token inputs arrived during the initial read
          if (this.tokenInputGeneration === readGeneration) {
            let denialPublished = false;
            await withFence((f) => {
              if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
              if (!this.activeRuntime || this.activeRuntime !== runtime) return;
              if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return;
              if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
              if (capturedTicket && f.latest.id !== capturedTicket) return;

              this.status = 'ACCESS_DENIED';
              this.user = targetUser;
              this.tokenResult = currentTokenResult;
              this.isAdmin = false;
              this.serverProofVerified = false;
              this.canRenderProtected = false;
              this.denialReason =
                'Your account does not have administrator authorization (custom claim admin: true is missing or false).';
              this.errorMessage = null;
              this.error = null;
              this.verificationErrorLatch = null;
              denialPublished = true;
            });
            if (denialPublished) {
              this.notify();
            }
            lastDrainedGen = readGeneration;
            return;
          }
          // Newer inputs arrived while fetching initial token; skip Phase 2 and jump to Phase 3
          // to drain the latest token and prove if admin claims are now present.
        } else {
          // Phase 2: Server-Authoritative Firestore Proof
          this.activeValidationPhase = 'SERVER_PROOF';
          const proofPromise = verifyServerAuthoritativeProof(runtime.db);
          const hook = (
            globalThis as unknown as {
              __holdAfterActualProof?: (
                p: Promise<ProofVerificationResult>
              ) => Promise<ProofVerificationResult>;
            }
          ).__holdAfterActualProof;
          const proofResult = hook ? await hook(proofPromise) : await proofPromise;

          if (!(await checkPublicationPredicate())) {
            return;
          }

          if (!proofResult.verified) {
            if (proofResult.code === 'permission-denied') {
              let denialPublished = false;
              await withFence((f) => {
                if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
                if (!this.activeRuntime || this.activeRuntime !== runtime) return;
                if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return;
                if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
                if (capturedTicket && f.latest.id !== capturedTicket) return;

                this.status = 'ACCESS_DENIED';
                this.user = targetUser;
                this.tokenResult = currentTokenResult;
                this.isAdmin = true;
                this.serverProofVerified = false;
                this.canRenderProtected = false;
                this.denialReason =
                  'Server-side authorization check failed. Firestore security rules rejected access to administrative configuration.';
                this.errorMessage = null;
                this.error = null;
                this.verificationErrorLatch = null;
                denialPublished = true;
              });
              if (denialPublished) {
                this.notify();
              }
            } else {
              let errorPublished = false;
              await withFence((f) => {
                if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
                if (!this.activeRuntime || this.activeRuntime !== runtime) return;
                if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
                if (capturedTicket && f.latest.id !== capturedTicket) return;

                this.status = 'ERROR';
                this.user = targetUser;
                this.tokenResult = currentTokenResult;
                this.isAdmin = true;
                this.serverProofVerified = false;
                this.canRenderProtected = false;
                this.denialReason = null;
                this.errorMessage = proofResult.error || 'Failed to verify backend authorization proof.';
                this.error = {
                  kind: 'VERIFICATION',
                  owner: capturedTicket,
                };
                this.verificationErrorLatch = {
                  owner: capturedTicket,
                  validationId: currentValidationId,
                  uid: targetUser.uid,
                };
                errorPublished = true;
              });
              if (errorPublished) {
                this.notify();
              }
            }
            lastDrainedGen = readGeneration;
            return;
          }

          capturedProofToken = currentTokenResult.token;
        }

        // Phase 3: FINAL_CHECK (drain latest token inputs and recheck/re-prove if changed)
        this.activeValidationPhase = 'FINAL_CHECK';
        let currentFreshToken = currentTokenResult;

        while (true) {
          const drainGen = this.tokenInputGeneration;
          currentFreshToken = await targetUser.getIdTokenResult(false);
          if (!(await checkPublicationPredicate())) {
            return;
          }

          // If new token inputs arrived during read, loop to drain
          if (this.tokenInputGeneration !== drainGen) {
            continue;
          }

          // If demoted (admin claim missing or false)
          if (!evaluateAdminClaim(currentFreshToken.claims)) {
            let demotionPublished = false;
            await withFence((f) => {
              if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
              if (!this.activeRuntime || this.activeRuntime !== runtime) return;
              if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
              if (capturedTicket && f.latest.id !== capturedTicket) return;

              this.status = 'ACCESS_DENIED';
              this.user = targetUser;
              this.tokenResult = currentFreshToken;
              this.isAdmin = false;
              this.serverProofVerified = false;
              this.canRenderProtected = false;
              this.denialReason =
                'Your account does not have administrator authorization (custom claim admin: true is missing or false).';
              this.errorMessage = null;
              this.error = null;
              this.verificationErrorLatch = null;
              demotionPublished = true;
            });
            if (demotionPublished) {
              this.notify();
            }
            lastDrainedGen = drainGen;
            return;
          }

          // If token string changed but still admin (F2) or unproven promoted token
          if (currentFreshToken.token !== capturedProofToken) {
            this.serverProofVerified = false;
            const newProof = await verifyServerAuthoritativeProof(runtime.db);
            if (!(await checkPublicationPredicate())) {
              return;
            }
            if (!newProof.verified) {
              if (newProof.code === 'permission-denied') {
                let denialPublished = false;
                await withFence((f) => {
                  if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
                  if (!this.activeRuntime || this.activeRuntime !== runtime) return;
                  if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return;
                  if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
                  if (capturedTicket && f.latest.id !== capturedTicket) return;

                  this.status = 'ACCESS_DENIED';
                  this.user = targetUser;
                  this.tokenResult = currentFreshToken;
                  this.isAdmin = true;
                  this.serverProofVerified = false;
                  this.canRenderProtected = false;
                  this.denialReason =
                    'Server-side authorization check failed. Firestore security rules rejected access to administrative configuration.';
                  this.errorMessage = null;
                  this.error = null;
                  this.verificationErrorLatch = null;
                  denialPublished = true;
                });
                if (denialPublished) this.notify();
              } else {
                let errPublished = false;
                await withFence((f) => {
                  if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
                  if (!this.activeRuntime || this.activeRuntime !== runtime) return;
                  if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
                  if (capturedTicket && f.latest.id !== capturedTicket) return;

                  this.status = 'ERROR';
                  this.user = targetUser;
                  this.tokenResult = currentFreshToken;
                  this.isAdmin = true;
                  this.serverProofVerified = false;
                  this.canRenderProtected = false;
                  this.denialReason = null;
                  this.errorMessage = newProof.error || 'Failed to verify backend authorization proof.';
                  this.error = {
                    kind: 'VERIFICATION',
                    owner: capturedTicket,
                  };
                  this.verificationErrorLatch = {
                    owner: capturedTicket,
                    validationId: currentValidationId,
                    uid: targetUser.uid,
                  };
                  errPublished = true;
                });
                if (errPublished) this.notify();
              }
              lastDrainedGen = drainGen;
              return;
            }
            capturedProofToken = currentFreshToken.token;
            if (this.tokenInputGeneration !== drainGen) {
              continue;
            }
          }

          // Final atomic publication under short lock
          const publicationGen = this.tokenInputGeneration;
          let published = false;
          await withFence((f) => {
            if (this.isStopped) return;
            if (this.bindingId !== bindingId) return;
            if (this.validationId !== currentValidationId) return;
            if (this.tokenInputGeneration !== publicationGen) return;
            if (!this.activeRuntime || this.activeRuntime !== runtime) return;
            if (!runtime.auth.currentUser || runtime.auth.currentUser.uid !== capturedUid) return;

            if (f.gate !== 'ACTIVE') return;
            if (f.latest.kind !== 'LOGIN') return;
            if (f.sessionId !== capturedSessionId) return;
            if (capturedTicket && f.latest.id !== capturedTicket) return;

            if (currentFreshToken.token !== capturedProofToken) return;
            if (!evaluateAdminClaim(currentFreshToken.claims)) return;

            this.status = 'AUTHORIZED_ADMIN';
            this.user = targetUser;
            this.tokenResult = currentFreshToken;
            this.isAdmin = true;
            this.serverProofVerified = true;
            this.canRenderProtected = true;
            this.denialReason = null;
            this.errorMessage = null;
            this.error = null;
            this.verificationErrorLatch = null;
            published = true;
          });

          if (published) {
            lastDrainedGen = publicationGen;
            this.notify();
            break;
          }

          if (this.tokenInputGeneration !== publicationGen) {
            continue;
          }
          break;
        }
      } catch (err: unknown) {
        let errPublished = false;
        await withFence((f) => {
          if (this.isStopped || this.bindingId !== bindingId || this.validationId !== currentValidationId) return;
          if (!this.activeRuntime || this.activeRuntime !== runtime) return;
          if (f.gate !== 'ACTIVE' || f.sessionId !== capturedSessionId) return;
          if (capturedTicket && f.latest.id !== capturedTicket) return;

          this.status = 'ERROR';
          this.user = targetUser;
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = `Authorization verification failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
          this.error = {
            kind: 'VERIFICATION',
            owner: capturedTicket,
          };
          this.verificationErrorLatch = {
            owner: capturedTicket,
            validationId: currentValidationId,
            uid: targetUser.uid,
          };
          errPublished = true;
        });
        if (errPublished) {
          lastDrainedGen = this.tokenInputGeneration;
          this.notify();
        }
      }
    })();

    this.activeValidationPromise = validationTask;
    try {
      await validationTask;
    } finally {
      if (this.activeValidationPromise === validationTask) {
        this.activeValidationPromise = null;
        this.activeValidationUid = null;
        this.activeValidationBindingId = null;
        this.activeValidationSessionId = null;
        this.activeValidationPhase = 'IDLE';

        if (
          this.tokenInputGeneration !== lastDrainedGen &&
          !this.isStopped &&
          !(
            this.verificationErrorLatch &&
            (this.verificationErrorLatch.owner === runtime.sessionId ||
              this.verificationErrorLatch.owner === this.intentId)
          )
        ) {
          const user = runtime.auth.currentUser;
          if (user && this.bindingId === bindingId) {
            this.runValidationPipeline(runtime, user, bindingId, false).catch(() => {});
          }
        }
      }
    }
  }

  public async login(email: string, password: string): Promise<LoginOutcome> {
    const loginTicket = crypto.randomUUID();
    const intent: Intent = { id: loginTicket, kind: 'LOGIN' };

    // Synchronously close local access and invalidate validation
    this.canRenderProtected = false;
    this.serverProofVerified = false;
    this.status = 'STAGING';
    this.intentId = loginTicket;
    this.notify();

    // 1. Atomically admit LOGIN intent under short lock
    await admitIntent(intent);

    // 2. Stage credentials concurrently in memory-only app
    const stagedAttempt = createStagedAttempt(intent, email, password);
    this.activeStagedAttempts.set(loginTicket, stagedAttempt);

    let stagedUser: User;
    try {
      const cred = await stagedAttempt.result;
      stagedUser = cred.user;
    } catch (err: unknown) {
      this.activeStagedAttempts.delete(loginTicket);
      stagedAttempt.disposeAfterSettlement().catch(() => {});

      // Check if this error belongs to our still-owned intent
      let owned = false;
      await withFence((f) => {
        if (f.latest.id !== loginTicket) return;
        owned = true;
        this.status = 'ERROR';
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        this.errorMessage = err instanceof Error ? err.message : String(err);
        this.error = {
          kind: 'CREDENTIALS',
          owner: loginTicket,
        };
      });
      if (!owned) {
        return 'SUPERSEDED';
      }

      this.notify();
      throw err;
    }

    // Check if superseded before waiting for canonical session and assign status atomically
    let waitingAssigned = false;
    await withFence((f) => {
      if (f.latest.id !== loginTicket) return;
      this.status = 'WAITING_FOR_SESSION';
      waitingAssigned = true;
    });
    if (!waitingAssigned) {
      this.activeStagedAttempts.delete(loginTicket);
      stagedAttempt.disposeAfterSettlement().catch(() => {});
      return 'SUPERSEDED';
    }
    this.notify();

    let canonicalRuntime: SessionRuntime;
    try {
      canonicalRuntime = await createCanonicalSessionRuntime(loginTicket);
    } catch (err: unknown) {
      this.activeStagedAttempts.delete(loginTicket);
      stagedAttempt.disposeAfterSettlement().catch(() => {});
      let stillOwned = false;
      await withFence((f) => {
        if (f.latest.id !== loginTicket) return;
        stillOwned = true;
        this.status = 'ERROR';
        this.errorMessage =
          err instanceof Error ? err.message : 'Canonical runtime preparation failed.';
        this.error = { kind: 'COORDINATION', owner: loginTicket };
      });
      if (stillOwned) {
        this.notify();
      }
      return 'ERROR';
    }

    // 4. Acquire long mutation lock for persistent transfer and finalization
    let outcome: LoginOutcome;
    try {
      outcome = await withMutationLock<LoginOutcome>(async () => {
        // Step A: Explicitly set indexedDB persistence
        let commitAssigned = false;
        await withFence((f) => {
          if (f.latest.id !== loginTicket) return;
          this.status = 'COMMITTING';
          commitAssigned = true;
        });
        if (!commitAssigned) {
          return 'SUPERSEDED';
        }
        this.notify();

        const p1 = await executeUnderFence((f) => {
          if (f.latest.id !== loginTicket) return null;
          f.gate = 'CLOSED';
          f.sessionId = loginTicket;
          return {
            invoke: () => {
              try {
                const promise = setPersistence(canonicalRuntime.auth, indexedDBLocalPersistence);
                registerOriginalPromise(
                  loginTicket,
                  { fenceIntent: loginTicket, sessionId: loginTicket },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p1) return 'SUPERSEDED';
        if (!p1.promise) throw p1.syncError;
        await p1.promise;

        // Step B: Transfer staged user with updateCurrentUser
        const p2 = await executeUnderFence((f) => {
          if (f.latest.id !== loginTicket) return null;
          return {
            invoke: () => {
              try {
                const promise = updateCurrentUser(canonicalRuntime.auth, stagedUser);
                registerOriginalPromise(
                  loginTicket,
                  { fenceIntent: loginTicket, sessionId: loginTicket },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p2) return 'SUPERSEDED';
        if (!p2.promise) throw p2.syncError;
        await p2.promise;

        // Verify canonical currentUser UID
        if (
          !canonicalRuntime.auth.currentUser ||
          canonicalRuntime.auth.currentUser.uid !== stagedUser.uid
        ) {
          throw new Error('Canonical transfer failed: auth.currentUser UID mismatch.');
        }

        // Step C: Write ACTIVE under short lock
        const activated = await withFence((f) => {
          if (f.latest.id !== loginTicket) return false;
          f.gate = 'ACTIVE';
          f.sessionId = loginTicket;
          return true;
        });

        if (!activated) return 'SUPERSEDED';

        return 'AUTHORIZED';
      });
    } catch (err: unknown) {
      let stillOwned = false;
      await withFence((f) => {
        if (f.latest.id !== loginTicket) return;
        stillOwned = true;
        this.status = 'ERROR';
        this.canRenderProtected = false;
        this.serverProofVerified = false;
        this.errorMessage = `Session storage failed: ${
          err instanceof Error ? err.message : String(err)
        }. Stored credentials could not be committed.`;
        this.error = {
          kind: 'COORDINATION',
          owner: loginTicket,
        };
      });
      if (stillOwned) {
        this.notify();
      }
      return 'ERROR';
    } finally {
      this.activeStagedAttempts.delete(loginTicket);
      stagedAttempt.disposeAfterSettlement().catch(() => {});
    }

    if (outcome === 'SUPERSEDED') {
      return 'SUPERSEDED';
    }

    // 5. Switch to canonical session and start fresh authorization verification
    const attached = await this.attachToCanonicalSession(loginTicket, loginTicket);
    if (!attached) {
      return 'SUPERSEDED';
    }

    const finalSnapshot = this.getSnapshot();
    if (
      finalSnapshot.sessionId !== loginTicket ||
      (this.intentId && this.intentId !== loginTicket)
    ) {
      return 'SUPERSEDED';
    }
    if (finalSnapshot.status === 'AUTHORIZED_ADMIN') return 'AUTHORIZED';
    if (finalSnapshot.status === 'ACCESS_DENIED') return 'DENIED';
    return 'ERROR';
  }

  public async logout(): Promise<void> {
    const logoutTicket = crypto.randomUUID();
    const currentSnapshot = this.getSnapshot();
    const targetSessionId = currentSnapshot.sessionId;

    // Synchronously close local access
    this.canRenderProtected = false;
    this.serverProofVerified = false;
    this.status = 'SIGNING_OUT';
    this.intentId = logoutTicket;
    this.notify();

    // Invalidate validation
    this.validationId += 1;

    // 1. Atomically admit LOGOUT intent under short lock
    const fence = await admitIntent({ id: logoutTicket, kind: 'LOGOUT' });
    const target = targetSessionId || fence.sessionId;

    // 2. Execute persistent mutation under long mutation lock
    await withMutationLock(async () => {
      if (!target) {
        let finalized = false;
        await withFence((f) => {
          if (f.latest.id !== logoutTicket) return;
          f.gate = 'SIGNED_OUT';
          f.sessionId = null;
          finalized = true;

          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
          this.sessionId = null;
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = null;
          this.error = null;
          this.verificationErrorLatch = null;
          this.activeRuntime = null;
        });
        if (finalized) {
          if (this.unsubscribeTokenObserver) {
            this.unsubscribeTokenObserver();
            this.unsubscribeTokenObserver = null;
          }
          this.notify();
        }
        return;
      }

      // Obtain or restore target runtime
      let targetRuntime: SessionRuntime;
      if (this.activeRuntime && this.activeRuntime.sessionId === target) {
        targetRuntime = this.activeRuntime;
      } else {
        targetRuntime = await createCleanupRuntime(target);
      }

      try {
        // Step A: setPersistence
        const p1 = await executeUnderFence((f) => {
          if (f.latest.id !== logoutTicket) return null;
          f.gate = 'CLOSED';
          f.sessionId = target;
          return {
            invoke: () => {
              try {
                const promise = setPersistence(targetRuntime.auth, indexedDBLocalPersistence);
                registerOriginalPromise(
                  logoutTicket,
                  { fenceIntent: logoutTicket, sessionId: target },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p1) return;
        if (!p1.promise) throw p1.syncError;
        await p1.promise;

        // Step B: signOut
        const p2 = await executeUnderFence((f) => {
          if (f.latest.id !== logoutTicket) return null;
          return {
            invoke: () => {
              try {
                const promise =
                  typeof (targetRuntime.auth as unknown as { signOut?: () => Promise<void> }).signOut ===
                  'function'
                    ? (targetRuntime.auth as unknown as { signOut: () => Promise<void> }).signOut()
                    : signOut(targetRuntime.auth);
                registerOriginalPromise(
                  logoutTicket,
                  { fenceIntent: logoutTicket, sessionId: target },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p2) return;
        if (!p2.promise) throw p2.syncError;
        await p2.promise;

        // Step C: Finalize SIGNED_OUT under short lock
        let finalized = false;
        await withFence((f) => {
          if (f.latest.id !== logoutTicket || f.sessionId !== target) return;
          f.gate = 'SIGNED_OUT';
          f.sessionId = null;
          finalized = true;

          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
          this.sessionId = null;
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = null;
          this.error = null;
          this.verificationErrorLatch = null;
          this.activeRuntime = null;
        });

        if (finalized) {
          if (this.unsubscribeTokenObserver) {
            this.unsubscribeTokenObserver();
            this.unsubscribeTokenObserver = null;
          }
          this.notify();
        }
      } catch (err: unknown) {
        let stillOwned = false;
        await withFence((f) => {
          if (f.latest.id !== logoutTicket || f.sessionId !== target) return;
          stillOwned = true;
          const message = err instanceof Error ? err.message : String(err);
          this.status = 'ERROR';
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = `Logout failed: ${message}. Session removal was rejected by authentication provider.`;
          this.error = {
            kind: 'LOGOUT',
            owner: logoutTicket,
            logoutTarget: { fenceIntent: logoutTicket, sessionId: target },
          };
        });
        if (stillOwned) {
          this.notify();
        }
        throw err;
      }
    });
  }

  public async retryLogout(target?: LogoutTarget): Promise<void> {
    const retryTicket = crypto.randomUUID();
    let targetSessionId: SessionId | null = null;

    // Atomically verify target and admit retry under short lock
    const admitted = await withFence((f) => {
      if (f.gate !== 'CLOSED') return false;
      if (target?.fenceIntent && f.latest.id !== target.fenceIntent) return false;
      if (target?.sessionId !== undefined && f.sessionId !== target.sessionId) return false;

      targetSessionId = target?.sessionId !== undefined ? target.sessionId : f.sessionId;
      f.latest = { id: retryTicket, kind: 'LOGOUT' };
      f.gate = 'CLOSED';
      // retain sessionId as cleanup target
      return true;
    });

    if (!admitted) {
      return;
    }

    this.canRenderProtected = false;
    this.serverProofVerified = false;
    this.status = 'SIGNING_OUT';
    this.intentId = retryTicket;
    this.notify();

    await withMutationLock(async () => {
      if (!targetSessionId) {
        let finalized = false;
        await withFence((f) => {
          if (f.latest.id !== retryTicket) return;
          f.gate = 'SIGNED_OUT';
          f.sessionId = null;
          finalized = true;

          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
          this.sessionId = null;
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = null;
          this.error = null;
          this.verificationErrorLatch = null;
          this.activeRuntime = null;
        });
        if (finalized) {
          if (this.unsubscribeTokenObserver) {
            this.unsubscribeTokenObserver();
            this.unsubscribeTokenObserver = null;
          }
          this.notify();
        }
        return;
      }

      let targetRuntime: SessionRuntime;
      if (this.activeRuntime && this.activeRuntime.sessionId === targetSessionId) {
        targetRuntime = this.activeRuntime;
      } else {
        targetRuntime = await createCleanupRuntime(targetSessionId);
      }

      try {
        const p1 = await executeUnderFence((f) => {
          if (
            f.gate !== 'CLOSED' ||
            f.latest.id !== retryTicket ||
            f.sessionId !== targetSessionId
          ) {
            return null;
          }
          return {
            invoke: () => {
              try {
                const promise = setPersistence(targetRuntime.auth, indexedDBLocalPersistence);
                registerOriginalPromise(
                  retryTicket,
                  { fenceIntent: retryTicket, sessionId: targetSessionId },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p1) return;
        if (!p1.promise) throw p1.syncError;
        await p1.promise;

        const p2 = await executeUnderFence((f) => {
          if (
            f.gate !== 'CLOSED' ||
            f.latest.id !== retryTicket ||
            f.sessionId !== targetSessionId
          ) {
            return null;
          }
          return {
            invoke: () => {
              try {
                const promise =
                  typeof (targetRuntime.auth as unknown as { signOut?: () => Promise<void> }).signOut ===
                  'function'
                    ? (targetRuntime.auth as unknown as { signOut: () => Promise<void> }).signOut()
                    : signOut(targetRuntime.auth);
                registerOriginalPromise(
                  retryTicket,
                  { fenceIntent: retryTicket, sessionId: targetSessionId },
                  promise
                );
                return { promise, syncError: null };
              } catch (err) {
                return { promise: null, syncError: err };
              }
            },
          };
        });

        if (!p2) return;
        if (!p2.promise) throw p2.syncError;
        await p2.promise;

        let finalized = false;
        await withFence((f) => {
          if (f.latest.id !== retryTicket || f.sessionId !== targetSessionId) return;
          f.gate = 'SIGNED_OUT';
          f.sessionId = null;
          finalized = true;

          this.status = 'UNAUTHENTICATED';
          this.user = null;
          this.tokenResult = null;
          this.sessionId = null;
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = null;
          this.error = null;
          this.verificationErrorLatch = null;
          this.activeRuntime = null;
        });

        if (finalized) {
          if (this.unsubscribeTokenObserver) {
            this.unsubscribeTokenObserver();
            this.unsubscribeTokenObserver = null;
          }
          this.notify();
        }
      } catch (err: unknown) {
        let stillOwned = false;
        await withFence((f) => {
          if (f.latest.id !== retryTicket || f.sessionId !== targetSessionId) return;
          stillOwned = true;
          const message = err instanceof Error ? err.message : String(err);
          this.status = 'ERROR';
          this.canRenderProtected = false;
          this.serverProofVerified = false;
          this.errorMessage = `Logout failed: ${message}. Session removal was rejected by authentication provider.`;
          this.error = {
            kind: 'LOGOUT',
            owner: retryTicket,
            logoutTarget: { fenceIntent: retryTicket, sessionId: targetSessionId },
          };
        });
        if (stillOwned) {
          this.notify();
        }
        throw err;
      }
    });
  }

  public async refreshAuthorization(): Promise<void> {
    const targetUser = this.user || this.activeRuntime?.auth.currentUser;
    if (!this.activeRuntime || !targetUser) return;
    this.isRefreshing = true;
    this.canRenderProtected = false;
    this.serverProofVerified = false;
    this.verificationErrorLatch = null;
    this.notify();

    try {
      await this.runValidationPipeline(this.activeRuntime, targetUser, this.bindingId, true);
    } finally {
      this.isRefreshing = false;
      this.notify();
    }
  }

  public async retryVerification(): Promise<void> {
    const targetUser = this.user || this.activeRuntime?.auth.currentUser;
    if (!this.activeRuntime || !targetUser) return;
    this.isRefreshing = true;
    this.canRenderProtected = false;
    this.serverProofVerified = false;
    this.errorMessage = null;
    this.denialReason = null;
    this.error = null;
    this.verificationErrorLatch = null;
    this.notify();

    try {
      // D6: Always pass forceRefresh = true on retry
      await this.runValidationPipeline(this.activeRuntime, targetUser, this.bindingId, true);
    } finally {
      this.isRefreshing = false;
      this.notify();
    }
  }
}

// Singleton coordinator instance for the application window
let globalCoordinator: AuthCoordinator | null = null;

export function getAuthCoordinator(): AuthCoordinator {
  if (typeof window !== 'undefined') {
    const win = window as unknown as { __towmitraAuthCoordinator?: AuthCoordinator };
    if (!win.__towmitraAuthCoordinator) {
      win.__towmitraAuthCoordinator = new AuthCoordinator();
    }
    return win.__towmitraAuthCoordinator;
  }
  if (!globalCoordinator) {
    globalCoordinator = new AuthCoordinator();
  }
  return globalCoordinator;
}

export function getSelectedAuth(): import('firebase/auth').Auth | null {
  return getAuthCoordinator().getActiveRuntime()?.auth || null;
}

export { updateCurrentUser } from 'firebase/auth';

if (typeof window !== 'undefined') {
  (window as unknown as { getSelectedAuth?: typeof getSelectedAuth }).getSelectedAuth = getSelectedAuth;
  (window as unknown as { updateCurrentUser?: typeof updateCurrentUser }).updateCurrentUser = updateCurrentUser;
}
