/**
 * TowMitra Phase 6 M2 — Operations Session Fencing Helper (M2-ARCH-1, Section 2)
 *
 * Integrates directly with canonical M1 AuthCoordinator and SessionRuntime without
 * modifying M1 code.
 *
 * Enforces:
 * - status === 'AUTHORIZED_ADMIN', canRenderProtected, serverProofVerified, isAdmin
 * - user.uid === runtime.auth.currentUser.uid
 * - snapshot/session runtime sessionId equality, active runtime object equality, no isCleanupOnly
 * - captured UID, sessionId, bindingId and generation match current values
 * - local sequence check before publishing any asynchronous result or toast
 */

import { getAuthCoordinator } from '@/auth/authCoordinator';
import type { SessionRuntime } from '@/auth/sessionRuntime';
import type { AuthSnapshot } from '@/types/auth';

export interface OperationsSessionScope {
  uid: string;
  sessionId: string;
  bindingId: number;
  generation: number;
  runtime: SessionRuntime;
}

export function getAuthorizedOperationsSession(snapshot?: AuthSnapshot): OperationsSessionScope | null {
  const coordinator = getAuthCoordinator();
  const currentSnapshot = snapshot || coordinator.getSnapshot();
  const runtime = coordinator.getActiveRuntime();

  if (!runtime || runtime.isCleanupOnly) {
    return null;
  }

  if (
    currentSnapshot.status !== 'AUTHORIZED_ADMIN' ||
    !currentSnapshot.canRenderProtected ||
    !currentSnapshot.serverProofVerified ||
    !currentSnapshot.isAdmin ||
    !currentSnapshot.user?.uid ||
    !currentSnapshot.sessionId
  ) {
    return null;
  }

  const currentAuthUser = runtime.auth.currentUser;
  if (!currentAuthUser || currentAuthUser.uid !== currentSnapshot.user.uid) {
    return null;
  }

  if (runtime.sessionId !== currentSnapshot.sessionId) {
    return null;
  }

  return {
    uid: currentSnapshot.user.uid,
    sessionId: currentSnapshot.sessionId,
    bindingId: currentSnapshot.bindingId,
    generation: currentSnapshot.generation,
    runtime,
  };
}

export function isOperationsSessionValid(scope: OperationsSessionScope): boolean {
  const coordinator = getAuthCoordinator();
  const currentSnapshot = coordinator.getSnapshot();
  const currentRuntime = coordinator.getActiveRuntime();

  if (!currentRuntime || currentRuntime !== scope.runtime || currentRuntime.isCleanupOnly) {
    return false;
  }

  if (
    currentSnapshot.status !== 'AUTHORIZED_ADMIN' ||
    !currentSnapshot.canRenderProtected ||
    !currentSnapshot.serverProofVerified ||
    !currentSnapshot.isAdmin ||
    currentSnapshot.user?.uid !== scope.uid ||
    currentSnapshot.sessionId !== scope.sessionId ||
    currentSnapshot.bindingId !== scope.bindingId ||
    currentSnapshot.generation !== scope.generation
  ) {
    return false;
  }

  const currentAuthUser = currentRuntime.auth.currentUser;
  if (!currentAuthUser || currentAuthUser.uid !== scope.uid) {
    return false;
  }

  return true;
}

export class SequenceTracker {
  private currentSeq = 0;

  public next(): number {
    return ++this.currentSeq;
  }

  public isCurrent(seq: number): boolean {
    return this.currentSeq === seq;
  }

  public get current(): number {
    return this.currentSeq;
  }

  public reset(): void {
    this.currentSeq++;
  }
}
