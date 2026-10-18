import type { User, IdTokenResult } from 'firebase/auth';

export type Ticket = string; // crypto.randomUUID(); never timestamp, UID or email
export type SessionId = Ticket; // canonical namespace derives from login ticket
export type IntentKind = 'LOGIN' | 'LOGOUT';

export interface Intent {
  id: Ticket;
  kind: IntentKind;
}

export type FenceGate = 'CLOSED' | 'ACTIVE' | 'SIGNED_OUT';

export interface Fence {
  v: 1;
  latest: Intent;
  gate: FenceGate;
  sessionId: SessionId | null;
}

export type LoginOutcome = 'AUTHORIZED' | 'DENIED' | 'SUPERSEDED' | 'ERROR';
export type LogoutTarget = { fenceIntent: Ticket; sessionId: SessionId | null };
export type AuthErrorKind = 'CREDENTIALS' | 'VERIFICATION' | 'LOGOUT' | 'COORDINATION';

export type CoordinatorStatus =
  | 'INITIALIZING'
  | 'UNAUTHENTICATED'
  | 'STAGING'
  | 'WAITING_FOR_SESSION'
  | 'COMMITTING'
  | 'VERIFYING_AUTHORIZATION'
  | 'AUTHORIZED_ADMIN'
  | 'ACCESS_DENIED'
  | 'SIGNING_OUT'
  | 'ERROR';

export type AuthStatus = CoordinatorStatus;

export interface AdminClaims {
  admin?: boolean | string | number | null;
  [key: string]: unknown;
}

export interface AuthState {
  status: CoordinatorStatus;
  user: User | null;
  tokenResult: IdTokenResult | null;
  isAdmin: boolean;
  serverProofVerified: boolean;
  denialReason: string | null;
  errorMessage: string | null;
  isRefreshing: boolean;
  generation: number;
}

export interface AuthSnapshot extends AuthState {
  sessionId: SessionId | null;
  intentId: Ticket | null;
  bindingId: number;
  canRenderProtected: boolean;
  error: {
    kind: AuthErrorKind;
    owner: Ticket | null;
    logoutTarget?: LogoutTarget;
  } | null;
}

export interface AuthContextValue extends AuthSnapshot {
  signIn: (email: string, password: string) => Promise<LoginOutcome>;
  signOutUser: () => Promise<void>;
  retryLogout: (target?: LogoutTarget) => Promise<void>;
  refreshAuthorization: () => Promise<void>;
  retryVerification: () => Promise<void>;
}
