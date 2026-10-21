/**
 * TowMitra Phase 6 M2 — Operational Types & Contracts (M2-ARCH-1)
 */

export interface ExactTimestamp {
  seconds: number;
  nanoseconds: number;
}

export interface FirestoreTimestampLike {
  seconds: number;
  nanoseconds: number;
  toDate?: () => Date;
  toMillis?: () => number;
}

export type VerificationStatus = 'pending' | 'approved' | 'rejected';
export type TruckType = 'flatbed' | 'tochan' | 'hydraulic' | 'crane';

export interface VerificationDocs {
  idPhotoUrl: string;
  rcPhotoUrl: string;
  selfiePhotoUrl: string;
  submittedAt: FirestoreTimestampLike;
}

export interface MonthlyCancelCount {
  month: string;
  count: number;
}

export interface DriverProfile {
  uid: string;
  name: string;
  vehicleNumber: string;
  phone: string;
  truckType: TruckType;
  isOnDuty: boolean;
  verificationStatus: VerificationStatus;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
  verificationDocs?: VerificationDocs;
  rejectionReason?: string | null;
  canFlatbed?: boolean;
  canPulling?: boolean;

  // Operational diagnostic fields (shown in diagnostic banner, not auto-provisioned)
  walletBalance?: number;
  activeJobId?: string | null;
  activeOfferId?: string | null;
  dutySessionId?: string | null;
  bannedUntil?: FirestoreTimestampLike | null;
  strictMode?: boolean;
  monthlyCancelCount?: MonthlyCancelCount | number;
  workerReady?: boolean;
}

export interface EvidenceFileState {
  docKey: 'id' | 'rc' | 'selfie';
  filename: 'id.jpg' | 'rc.jpg' | 'selfie.jpg';
  url: string; // gs:// path
  dataUrl: string | null;
  generation: string | null;
  size: number;
  contentType: string;
  loading: boolean;
  error: string | null;
  isAuthDenial?: boolean;
}

export interface EvidenceState {
  id: EvidenceFileState;
  rc: EvidenceFileState;
  selfie: EvidenceFileState;
  allDecoded: boolean;
}

export interface DecisionResult {
  success: boolean;
  driverUid: string;
  verificationStatus: 'approved' | 'rejected';
  reviewedSubmittedAt: ExactTimestamp;
  actionId: string;
  replayed: boolean;
}

export interface SubmittedDecision {
  requestId: string;
  driverUid: string;
  operation: 'adminApproveDriver' | 'adminRejectDriver';
  expectedUpdatedAt: ExactTimestamp;
  expectedSubmittedAt: ExactTimestamp;
  canFlatbed?: boolean;
  canPulling?: boolean;
  expectedObjectGenerations?: { id: string; rc: string; selfie: string };
  reason?: string;
  status: 'in_flight' | 'committed' | 'failed';
  result?: DecisionResult;
  error?: string;
  errorCode?: string;
}

export type JobStatus =
  | 'awaiting_payment'
  | 'pending_offer'
  | 'offered'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled_customer'
  | 'cancelled_system'
  | 'cancelled_driver';

export interface DispatchLastFailure {
  code: string;
  source: string;
  retryable: boolean;
  occurredAt?: FirestoreTimestampLike;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  towingCategory: string;
  customerPhone: string;
  pickupCoords?: { latitude: number; longitude: number };
  destCoords?: { latitude: number; longitude: number };
  bookingFeePaise?: number;
  driverCommissionPaise?: number;
  estimatedFarePaise?: number;
  dispatchGeneration?: number;
  dispatchRunId?: string;
  dispatchState?: string;
  currentDispatchRunId?: string;
  currentOfferId?: string;
  offeredTo?: string;
  assignedDriver?: string;
  offerExpiresAt?: FirestoreTimestampLike;
  operational_hold?: boolean;
  dispatchLastFailure?: DispatchLastFailure;
  dispatchNextActionAt?: FirestoreTimestampLike;
  cancellationResolutionState?: string;
  cancelledBy?: string;
  cancellationReason?: string;
  cancellationRequestedAt?: FirestoreTimestampLike;
  cancellationResolvedAt?: FirestoreTimestampLike;
  customerCancellationPending?: boolean;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface DispatchCandidate {
  driverUid?: string;
  driverId?: string;
  etaSeconds?: number;
  distanceMeters?: number;
  status?: string;
  reason?: string;
  round?: number;
}

export interface DispatchRunRecord {
  id: string;
  jobId: string;
  dispatchGeneration?: number;
  generation?: number;
  status: string;
  nextCandidateIndex?: number;
  candidateCount?: number;
  round?: number;
  rankingMode?: string;
  candidates?: DispatchCandidate[];
  createdAt?: FirestoreTimestampLike;
  updatedAt?: FirestoreTimestampLike;
}

export interface DriverIdentitySummary {
  uid: string;
  name: string;
  phone: string;
  vehicleNumber: string;
  truckType: string;
  lastFetchedAt: Date;
}

export interface OfferRecord {
  id: string;
  jobId: string;
  dispatchGeneration: number;
  candidateIndex: number;
  offeredTo: string;
  status: string;
  expiresAt: FirestoreTimestampLike;
  createdAt: FirestoreTimestampLike;
}

export interface PaginationSnapshot<T> {
  items: T[];
  pageIndex: number;
  hasMore: boolean;
  isLive: boolean;
  lastServerConfirmation: Date | null;
  isOffline: boolean;
  error: string | null;
}
