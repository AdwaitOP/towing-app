/**
 * TowMitra Phase 6 M2 — Driver Verification Queue Hook (M2-ARCH-1, Section 3 & 6)
 *
 * Responsibilities:
 * - Route/tab-scoped subscriptions (max 2 stable Firestore listeners: list + selected driver)
 * - Fencing against session loss/replacement/refresh and local sequence numbers
 * - Bounded pagination: live first page, bounded server snapshots for older pages with canonical cursor stack
 * - Evidence loader queue integration with cancellation token and automatic data URL cleanup
 * - Retains in-memory submitted decision identity for safe same-request retries (reconciliation)
 * - Immediately invalidates sensitive data and subscriptions on permission denial, logout or unmount
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { QueryDocumentSnapshot, Unsubscribe } from 'firebase/firestore';
import { useAuth } from '@/context/AuthContext';
import {
  getAuthorizedOperationsSession,
  isOperationsSessionValid,
  SequenceTracker,
  type OperationsSessionScope,
} from '@/services/operationsSession';
import {
  subscribeToFirstPage,
  fetchSnapshotPage,
  subscribeToDriverDetail,
  loadSingleEvidenceFile,
  createInitialEvidenceState,
  callAdminApproveDriver,
  callAdminRejectDriver,
  type DriverListSnapshot,
} from '@/services/driverVerification';

export { createInitialEvidenceState };
import type {
  DriverProfile,
  VerificationStatus,
  EvidenceState,
  SubmittedDecision,
  DecisionResult,
  ExactTimestamp,
} from '@/types/operations';

export function isPermissionOrAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown };
  if (typeof e.code !== 'string') return false;
  const code = e.code.toLowerCase().replace(/^functions\//, '');
  return code === 'permission-denied' || code === 'unauthenticated';
}

export function isDefinitiveFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isPermissionOrAuthError(err)) return true;
  const e = err as { code?: unknown };
  if (typeof e.code !== 'string') return false;
  const code = e.code.toLowerCase().replace(/^functions\//, '');
  return (
    code === 'failed-precondition' ||
    code === 'invalid-argument' ||
    code === 'out-of-range' ||
    code === 'not-found' ||
    code === 'already-exists'
  );
}

export const MIN_FIRESTORE_SECONDS = -62135596800;
export const MAX_FIRESTORE_SECONDS = 253402300799;

export function isValidTimestamp(ts: unknown): boolean {
  if (!ts || typeof ts !== 'object') return false;
  const t = ts as { seconds?: unknown; nanoseconds?: unknown; toDate?: () => unknown };
  if (typeof t.toDate === 'function') {
    try {
      const d = t.toDate();
      if (d instanceof Date && !isNaN(d.getTime())) return true;
    } catch {
      return false;
    }
  }
  return (
    typeof t.seconds === 'number' &&
    Number.isSafeInteger(t.seconds) &&
    t.seconds >= MIN_FIRESTORE_SECONDS &&
    t.seconds <= MAX_FIRESTORE_SECONDS &&
    typeof t.nanoseconds === 'number' &&
    Number.isSafeInteger(t.nanoseconds) &&
    t.nanoseconds >= 0 &&
    t.nanoseconds <= 999999999
  );
}

export const DEFAULT_STORAGE_BUCKET = 'demo-towmitra-admin.appspot.com';

export function isProfileEnvelopeInvalid(
  driver: Partial<DriverProfile> | null,
  expectedBucket: string = DEFAULT_STORAGE_BUCKET
): boolean {
  if (!driver || typeof driver !== 'object') return true;
  if (typeof driver.uid !== 'string' || !driver.uid || driver.uid.length > 128 || driver.uid.includes('/') || /\s/.test(driver.uid)) return true;
  if (typeof driver.name !== 'string' || !driver.name.trim()) return true;
  if (typeof driver.vehicleNumber !== 'string' || !driver.vehicleNumber.trim()) return true;
  if (typeof driver.phone !== 'string' || !/^\+[1-9]\d{9,14}$/.test(driver.phone.trim())) return true;
  if (typeof driver.truckType !== 'string' || !['flatbed', 'tochan', 'hydraulic', 'crane'].includes(driver.truckType)) return true;
  if (!isValidTimestamp(driver.createdAt) || !isValidTimestamp(driver.updatedAt)) return true;

  const docs = driver.verificationDocs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return true;
  const keys = Object.keys(docs);
  if (keys.length !== 4) return true;
  if (!['idPhotoUrl', 'rcPhotoUrl', 'selfiePhotoUrl', 'submittedAt'].every((k) => keys.includes(k))) return true;
  if (!isValidTimestamp(docs.submittedAt)) return true;

  const idMatch = typeof docs.idPhotoUrl === 'string' && docs.idPhotoUrl.match(/^gs:\/\/([^/]+)\/driver_verification\/([^/]+)\/id\.jpg$/);
  const rcMatch = typeof docs.rcPhotoUrl === 'string' && docs.rcPhotoUrl.match(/^gs:\/\/([^/]+)\/driver_verification\/([^/]+)\/rc\.jpg$/);
  const selfieMatch = typeof docs.selfiePhotoUrl === 'string' && docs.selfiePhotoUrl.match(/^gs:\/\/([^/]+)\/driver_verification\/([^/]+)\/selfie\.jpg$/);
  if (!idMatch || !rcMatch || !selfieMatch) return true;
  if (idMatch[2] !== driver.uid || rcMatch[2] !== driver.uid || selfieMatch[2] !== driver.uid) return true;

  const targetBucket = expectedBucket || DEFAULT_STORAGE_BUCKET;
  if (idMatch[1] !== targetBucket || rcMatch[1] !== targetBucket || selfieMatch[1] !== targetBucket) return true;

  if (typeof driver.isOnDuty !== 'boolean' || driver.isOnDuty !== false) return true;
  if (driver.activeJobId !== undefined && driver.activeJobId !== null) return true;
  if (driver.activeOfferId !== undefined && driver.activeOfferId !== null) return true;
  if (driver.dutySessionId !== undefined && driver.dutySessionId !== null) return true;
  if ('workerReady' in driver && driver.workerReady !== undefined && driver.workerReady !== false) return true;
  if ('canFlatbed' in driver && driver.canFlatbed !== undefined && typeof driver.canFlatbed !== 'boolean') return true;
  if ('canPulling' in driver && driver.canPulling !== undefined && typeof driver.canPulling !== 'boolean') return true;
  if ('rejectionReason' in driver && driver.rejectionReason !== null && typeof driver.rejectionReason !== 'string') return true;

  return false;
}

export function useVerificationQueue() {
  const authContext = useAuth();
  const sessionScope = useMemo(() => getAuthorizedOperationsSession(authContext), [authContext]);

  const [statusTab, setStatusTab] = useState<VerificationStatus>('pending');
  const [drivers, setDrivers] = useState<DriverProfile[]>([]);
  const [selectedDriverUid, setSelectedDriverUid] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<DriverProfile | null>(null);
  const [selectedDriverLoading, setSelectedDriverLoading] = useState(false);
  const [selectedDriverFromCache, setSelectedDriverFromCache] = useState(false);
  const [selectedDriverError, setSelectedDriverError] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<EvidenceState>(createInitialEvidenceState());
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isFromCache, setIsFromCache] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastServerConfirmation, setLastServerConfirmation] = useState<Date | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [error, setError] = useState<string | null>(null);

  // Authoritative live derivation
  const isLive = !isOffline && !isFromCache && pageIndex === 0 && Boolean(lastServerConfirmation);

  // Retain submitted requests in memory per session/target
  const [submittedDecisions, setSubmittedDecisions] = useState<Map<string, SubmittedDecision>>(
    () => new Map()
  );

  const [selectionRevision, setSelectionRevision] = useState<number>(0);

  // Synchronous session-scoped request-ID registry and in-flight target tracker (D03)
  const sessionRequestRegistryRef = useRef<Map<string, SubmittedDecision>>(new Map());
  const inFlightDriverTargetRef = useRef<Map<string, string>>(new Map());

  // Cursors stack for backward pagination
  const cursorStackRef = useRef<QueryDocumentSnapshot[]>([]);
  const currentSnapshotsRef = useRef<QueryDocumentSnapshot[]>([]);

  // Sequence trackers
  const listSeqRef = useRef(new SequenceTracker());
  const detailSeqRef = useRef(new SequenceTracker());
  const evidenceSeqRef = useRef(new SequenceTracker());

  // Cancellation token for active/queued evidence downloads
  const evidenceCancelTokenRef = useRef<{ isCancelled: boolean }>({ isCancelled: false });
  const selectedDriverRef = useRef<DriverProfile | null>(null);
  const activeEvidenceOpRef = useRef<{
    driverUid: string;
    updatedAtSeconds: number;
    updatedAtNanos: number;
    selectionSeq: number;
    cancelToken: { isCancelled: boolean };
  } | null>(null);

  // Mount lifecycle tracking
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Immutable ownership and ABA-prevention trackers
  const selectionEpochRef = useRef<number>(0);
  const operationTokenRef = useRef<number>(0);
  const activeOpTokenByTargetRef = useRef<Map<string, number>>(new Map());
  const reviewEpochRef = useRef<number>(0);
  const currentReviewVersionRef = useRef<{
    uid: string;
    updatedAtSeconds?: number;
    updatedAtNanos?: number;
    submittedAtSeconds?: number;
    submittedAtNanos?: number;
  } | null>(null);

  // Listeners
  const listUnsubRef = useRef<Unsubscribe | null>(null);
  const detailUnsubRef = useRef<Unsubscribe | null>(null);
  const selectedDriverUidRef = useRef<string | null>(null);

  // Offline listeners (never use online event to assume live connection)
  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Centralized permission-denied / unauthenticated error handler
  const handleFeaturePermissionDenial = useCallback(() => {
    if (!isMountedRef.current || !sessionScope || !isOperationsSessionValid(sessionScope)) return;
    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    selectedDriverRef.current = null;
    selectedDriverUidRef.current = null;
    setSelectionRevision((prev) => prev + 1);
    setDrivers([]);
    setSelectedDriver(null);
    setSelectedDriverUid(null);
    setEvidence(createInitialEvidenceState());
    setSubmittedDecisions(new Map());
    sessionRequestRegistryRef.current.clear();
    inFlightDriverTargetRef.current.clear();
    activeOpTokenByTargetRef.current.clear();
    evidenceCancelTokenRef.current.isCancelled = true;
    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }
    if (detailUnsubRef.current) {
      detailUnsubRef.current();
      detailUnsubRef.current = null;
    }
    authContext.refreshAuthorization();
  }, [authContext, sessionScope]);

  // Shared ownership predicate for authorization denial handling across approve/reject/retry
  const isCurrentAttemptAuthorizedForDenial = useCallback(
    (capturedOwnership: {
      sessionScope: OperationsSessionScope;
      targetUid: string;
      opToken: number;
      selectionEpoch: number;
    }) => {
      const curReview = selectedDriverRef.current;
      return (
        isMountedRef.current &&
        isOperationsSessionValid(capturedOwnership.sessionScope) &&
        activeOpTokenByTargetRef.current.get(capturedOwnership.targetUid) === capturedOwnership.opToken &&
        selectionEpochRef.current === capturedOwnership.selectionEpoch &&
        curReview !== null &&
        curReview.uid === capturedOwnership.targetUid
      );
    },
    []
  );

  // Clean up listeners and queued work on unmount
  useEffect(() => {
    const sessionRegistry = sessionRequestRegistryRef.current;
    const inFlightTargets = inFlightDriverTargetRef.current;
    const activeOpTokens = activeOpTokenByTargetRef.current;
    return () => {
      evidenceCancelTokenRef.current.isCancelled = true;
      selectedDriverUidRef.current = null;
      sessionRegistry.clear();
      inFlightTargets.clear();
      activeOpTokens.clear();
      if (listUnsubRef.current) {
        listUnsubRef.current();
        listUnsubRef.current = null;
      }
      if (detailUnsubRef.current) {
        detailUnsubRef.current();
        detailUnsubRef.current = null;
      }
    };
  }, []);

  // ── Attach List Listener ──────────────────────────────────────────────────

  const refresh = useCallback(() => {
    if (!sessionScope || !isOperationsSessionValid(sessionScope)) return;

    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    detailSeqRef.current.next();
    evidenceSeqRef.current.next();
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;

    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }
    if (detailUnsubRef.current) {
      detailUnsubRef.current();
      detailUnsubRef.current = null;
    }

    selectedDriverRef.current = null;
    selectedDriverUidRef.current = null;
    setSelectionRevision((prev) => prev + 1);
    setSelectedDriverUid(null);
    setSelectedDriver(null);
    setEvidence(createInitialEvidenceState());

    const seq = listSeqRef.current.next();
    setIsLoading(true);
    setError(null);
    setPageIndex(0);
    cursorStackRef.current = [];

    listUnsubRef.current = subscribeToFirstPage(
      sessionScope.runtime.db,
      statusTab,
      (snap: DriverListSnapshot) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setDrivers(snap.drivers);
        currentSnapshotsRef.current = snap.snapshots;
        setHasMore(snap.hasMore);
        setIsLoading(false);
        setIsOffline(snap.isFromCache);
        setIsFromCache(snap.isFromCache);
        if (snap.lastServerConfirmation) {
          setLastServerConfirmation(snap.lastServerConfirmation);
        }
      },
      (err: Error) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setIsLoading(false);
        setError(err.message || 'Failed to load driver queue');
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );
  }, [sessionScope, statusTab, handleFeaturePermissionDenial]);

  const backToLive = useCallback(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }

    if (!sessionScope || !isOperationsSessionValid(sessionScope)) {
      return;
    }

    const seq = listSeqRef.current.next();
    const unsub = subscribeToFirstPage(
      sessionScope.runtime.db,
      statusTab,
      (snap: DriverListSnapshot) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setDrivers(snap.drivers);
        currentSnapshotsRef.current = snap.snapshots;
        setHasMore(snap.hasMore);
        setIsLoading(false);
        setIsOffline(snap.isFromCache);
        setIsFromCache(snap.isFromCache);
        if (snap.lastServerConfirmation) {
          setLastServerConfirmation(snap.lastServerConfirmation);
        }
      },
      (err: Error) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setIsLoading(false);
        setError(err.message || 'Failed to load driver queue');
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );

    listUnsubRef.current = unsub;
    return () => {
      if (listUnsubRef.current) {
        listUnsubRef.current();
        listUnsubRef.current = null;
      }
    };
  }, [sessionScope, statusTab, handleFeaturePermissionDenial]);

  // ── Navigation ────────────────────────────────────────────────────────────

  const goToNextPage = useCallback(async () => {
    if (!sessionScope || !isOperationsSessionValid(sessionScope) || !hasMore) return;
    const snapshots = currentSnapshotsRef.current;
    if (snapshots.length === 0) return;

    const nextCursor = snapshots[snapshots.length - 1];
    cursorStackRef.current.push(nextCursor);

    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }

    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    detailSeqRef.current.next();
    evidenceSeqRef.current.next();
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;
    if (detailUnsubRef.current) {
      detailUnsubRef.current();
      detailUnsubRef.current = null;
    }
    selectedDriverRef.current = null;
    selectedDriverUidRef.current = null;
    setSelectionRevision((prev) => prev + 1);
    setSelectedDriverUid(null);
    setSelectedDriver(null);
    setEvidence(createInitialEvidenceState());

    const seq = listSeqRef.current.next();
    setIsLoading(true);

    try {
      const snap = await fetchSnapshotPage(sessionScope.runtime.db, statusTab, nextCursor);
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      setDrivers(snap.drivers);
      currentSnapshotsRef.current = snap.snapshots;
      setHasMore(snap.hasMore);
      setPageIndex((p) => p + 1);
      setIsLoading(false);
      setIsOffline(false);
      setIsFromCache(false);
      if (snap.lastServerConfirmation) {
        setLastServerConfirmation(snap.lastServerConfirmation);
      }
    } catch (err: unknown) {
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      cursorStackRef.current.pop();
      setIsLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to fetch page');
      if (isPermissionOrAuthError(err)) {
        handleFeaturePermissionDenial();
      }
    }
  }, [sessionScope, hasMore, statusTab, handleFeaturePermissionDenial]);

  const goToPreviousPage = useCallback(async () => {
    if (pageIndex <= 1) {
      refresh();
      return;
    }

    if (!sessionScope || !isOperationsSessionValid(sessionScope)) return;
    const popped = cursorStackRef.current.pop();
    const prevCursor = cursorStackRef.current[cursorStackRef.current.length - 1];
    if (!prevCursor) {
      refresh();
      return;
    }

    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    detailSeqRef.current.next();
    evidenceSeqRef.current.next();
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;
    if (detailUnsubRef.current) {
      detailUnsubRef.current();
      detailUnsubRef.current = null;
    }
    selectedDriverRef.current = null;
    selectedDriverUidRef.current = null;
    setSelectionRevision((prev) => prev + 1);
    setSelectedDriverUid(null);
    setSelectedDriver(null);
    setEvidence(createInitialEvidenceState());

    const seq = listSeqRef.current.next();
    setIsLoading(true);

    try {
      const snap = await fetchSnapshotPage(sessionScope.runtime.db, statusTab, prevCursor);
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      setDrivers(snap.drivers);
      currentSnapshotsRef.current = snap.snapshots;
      setHasMore(snap.hasMore);
      setPageIndex((p) => p - 1);
      setIsLoading(false);
      setIsOffline(false);
      setIsFromCache(false);
      if (snap.lastServerConfirmation) {
        setLastServerConfirmation(snap.lastServerConfirmation);
      }
    } catch (err: unknown) {
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      if (popped) cursorStackRef.current.push(popped);
      setIsLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to fetch previous page');
      if (isPermissionOrAuthError(err)) {
        handleFeaturePermissionDenial();
      }
    }
  }, [sessionScope, pageIndex, refresh, statusTab, handleFeaturePermissionDenial]);

  // Safe handler to change tab and clear selection
  const changeStatusTab = useCallback((newTab: VerificationStatus) => {
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;
    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    detailSeqRef.current.next();
    evidenceSeqRef.current.next();
    selectedDriverRef.current = null;
    selectedDriverUidRef.current = null;
    setSelectionRevision((prev) => prev + 1);
    setStatusTab(newTab);
    setSelectedDriverUid(null);
    setSelectedDriver(null);
    setEvidence(createInitialEvidenceState());
    setPageIndex(0);
    cursorStackRef.current = [];
  }, []);

  const selectDriver = useCallback((uid: string | null) => {
    if (uid !== null && uid === selectedDriverUidRef.current) {
      return;
    }
    selectedDriverUidRef.current = uid;
    setSelectionRevision((prev) => prev + 1);
    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    currentReviewVersionRef.current = null;
    detailSeqRef.current.next();
    evidenceSeqRef.current.next();
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;
    selectedDriverRef.current = null;
    setSelectedDriverUid(uid);
    setSelectedDriver(null);
    setEvidence(createInitialEvidenceState());
    if (!uid) {
      setSelectedDriverLoading(false);
      setSelectedDriverError(null);
      setEvidenceLoading(false);
    } else {
      setSelectedDriverLoading(true);
      setSelectedDriverError(null);
      setEvidenceLoading(true);
    }
  }, []);

  // Render-phase adjustments to avoid setState inside effect bodies
  const currentSelectionKey = selectedDriverUid ? `${selectedDriverUid}:${selectionRevision}` : null;
  const [prevSelectionKey, setPrevSelectionKey] = useState<string | null>(null);
  if (currentSelectionKey !== prevSelectionKey) {
    setPrevSelectionKey(currentSelectionKey);
    setSelectedDriver(null);
    setSelectedDriverLoading(Boolean(selectedDriverUid));
  }

  if ((!selectedDriverUid || !sessionScope || !isOperationsSessionValid(sessionScope)) && selectedDriverLoading) {
    setSelectedDriverLoading(false);
  }

  const currentDriverKey = selectedDriver
    ? `${selectedDriver.uid}_${selectedDriver.updatedAt?.seconds}_${selectedDriver.updatedAt?.nanoseconds}`
    : null;
  const [prevDriverKey, setPrevDriverKey] = useState<string | null>(null);
  if (currentDriverKey !== prevDriverKey) {
    setPrevDriverKey(currentDriverKey);
    setEvidence(createInitialEvidenceState());
    setEvidenceLoading(Boolean(currentDriverKey));
  }

  const hasValidDriverForEvidence = Boolean(
    selectedDriver &&
      sessionScope &&
      isOperationsSessionValid(sessionScope) &&
      selectedDriver.verificationDocs &&
      !isProfileEnvelopeInvalid(selectedDriver, `${sessionScope?.runtime.app.options.projectId}.appspot.com`)
  );

  if (!hasValidDriverForEvidence && evidenceLoading) {
    setEvidenceLoading(false);
  }

  // ── Selected Driver Listener ──────────────────────────────────────────────

  useEffect(() => {
    if (detailUnsubRef.current) {
      detailUnsubRef.current();
      detailUnsubRef.current = null;
    }

    if (!selectedDriverUid || !sessionScope || !isOperationsSessionValid(sessionScope)) {
      detailSeqRef.current.next();
      selectedDriverRef.current = null;
      selectedDriverUidRef.current = null;
      return;
    }

    const expectedUid = selectedDriverUid;
    const seq = detailSeqRef.current.next();
    const unsub = subscribeToDriverDetail(
      sessionScope.runtime.db,
      expectedUid,
      (driver: DriverProfile | null, isFromCache: boolean) => {
        if (!detailSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        if (driver !== null && driver.uid !== expectedUid) return;

        if (driver !== null) {
          const prevVer = currentReviewVersionRef.current;
          const isSameVersion =
            prevVer !== null &&
            prevVer.uid === driver.uid &&
            prevVer.updatedAtSeconds === driver.updatedAt?.seconds &&
            prevVer.updatedAtNanos === driver.updatedAt?.nanoseconds &&
            prevVer.submittedAtSeconds === driver.verificationDocs?.submittedAt?.seconds &&
            prevVer.submittedAtNanos === driver.verificationDocs?.submittedAt?.nanoseconds;

          if (!isSameVersion) {
            if (prevVer !== null) {
              reviewEpochRef.current += 1;
            }
            currentReviewVersionRef.current = {
              uid: driver.uid,
              updatedAtSeconds: driver.updatedAt?.seconds,
              updatedAtNanos: driver.updatedAt?.nanoseconds,
              submittedAtSeconds: driver.verificationDocs?.submittedAt?.seconds,
              submittedAtNanos: driver.verificationDocs?.submittedAt?.nanoseconds,
            };
          }
        } else {
          currentReviewVersionRef.current = null;
          reviewEpochRef.current += 1;
        }

        selectedDriverRef.current = driver;
        setSelectedDriver(driver);
        setSelectedDriverLoading(false);
        setSelectedDriverFromCache(isFromCache);
        if (!driver) {
          inFlightDriverTargetRef.current.delete(expectedUid);
          setSelectedDriverError('Driver application not found');
          if (activeEvidenceOpRef.current) {
            activeEvidenceOpRef.current.cancelToken.isCancelled = true;
          }
          evidenceCancelTokenRef.current.isCancelled = true;
          evidenceSeqRef.current.next();
          setEvidence(createInitialEvidenceState());
          setEvidenceLoading(false);
          selectedDriverUidRef.current = null;
          setSelectionRevision((prev) => prev + 1);
          setSelectedDriverUid(null);
        }
      },
      (err: Error) => {
        if (!detailSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setSelectedDriverLoading(false);
        setSelectedDriverError(err.message || 'Failed to load driver details');
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );

    detailUnsubRef.current = unsub;
    const detailSeq = detailSeqRef.current;
    return () => {
      detailSeq.next();
      if (detailUnsubRef.current) {
        detailUnsubRef.current();
        detailUnsubRef.current = null;
      }
    };
  }, [selectedDriverUid, selectionRevision, sessionScope, handleFeaturePermissionDenial]);

  // ── Load evidence whenever selected driver changes ───────────────────────

  useEffect(() => {
    if (activeEvidenceOpRef.current) {
      activeEvidenceOpRef.current.cancelToken.isCancelled = true;
    }
    evidenceCancelTokenRef.current.isCancelled = true;
    const cancelToken = { isCancelled: false };
    evidenceCancelTokenRef.current = cancelToken;

    if (!hasValidDriverForEvidence || !selectedDriver || !sessionScope || !selectedDriver.verificationDocs) {
      return () => {
        cancelToken.isCancelled = true;
      };
    }

    const docs = selectedDriver.verificationDocs;
    const expectedBucket = `${sessionScope.runtime.app.options.projectId}.appspot.com`;
    const uid = selectedDriver.uid;
    const seq = evidenceSeqRef.current.next();

    const opContext = {
      driverUid: uid,
      updatedAtSeconds: selectedDriver.updatedAt.seconds,
      updatedAtNanos: selectedDriver.updatedAt.nanoseconds,
      selectionSeq: seq,
      cancelToken,
    };
    activeEvidenceOpRef.current = opContext;

    let isSubscribed = true;

    const loadAll = async () => {
      const [idState, rcState, selfieState] = await Promise.all([
        loadSingleEvidenceFile(
          sessionScope.runtime.storage,
          docs.idPhotoUrl,
          expectedBucket,
          uid,
          'id',
          'id.jpg',
          () => opContext.cancelToken.isCancelled || !isSubscribed
        ),
        loadSingleEvidenceFile(
          sessionScope.runtime.storage,
          docs.rcPhotoUrl,
          expectedBucket,
          uid,
          'rc',
          'rc.jpg',
          () => opContext.cancelToken.isCancelled || !isSubscribed
        ),
        loadSingleEvidenceFile(
          sessionScope.runtime.storage,
          docs.selfiePhotoUrl,
          expectedBucket,
          uid,
          'selfie',
          'selfie.jpg',
          () => opContext.cancelToken.isCancelled || !isSubscribed
        ),
      ]);

      if (
        !isSubscribed ||
        opContext.cancelToken.isCancelled ||
        !evidenceSeqRef.current.isCurrent(seq) ||
        !isOperationsSessionValid(sessionScope) ||
        selectedDriverRef.current?.uid !== opContext.driverUid ||
        selectedDriverRef.current?.updatedAt?.seconds !== opContext.updatedAtSeconds ||
        selectedDriverRef.current?.updatedAt?.nanoseconds !== opContext.updatedAtNanos
      ) {
        return;
      }

      if (idState.isAuthDenial || rcState.isAuthDenial || selfieState.isAuthDenial) {
        handleFeaturePermissionDenial();
        return;
      }

      const allDecoded = Boolean(
        idState.dataUrl &&
          rcState.dataUrl &&
          selfieState.dataUrl &&
          !idState.error &&
          !rcState.error &&
          !selfieState.error &&
          idState.generation &&
          rcState.generation &&
          selfieState.generation
      );
      setEvidence({
        id: idState,
        rc: rcState,
        selfie: selfieState,
        allDecoded,
      });
      setEvidenceLoading(false);
    };

    loadAll();
    return () => {
      isSubscribed = false;
      opContext.cancelToken.isCancelled = true;
    };
  }, [selectedDriver, sessionScope, hasValidDriverForEvidence, handleFeaturePermissionDenial]);

  const retryEvidenceFile = useCallback(
    async (fileKind: 'id' | 'rc' | 'selfie') => {
      const currentDriver = selectedDriverRef.current;
      if (!currentDriver || !currentDriver.verificationDocs || !sessionScope || !isOperationsSessionValid(sessionScope)) return;
      const docs = currentDriver.verificationDocs;
      const expectedBucket = `${sessionScope.runtime.app.options.projectId}.appspot.com`;
      const uid = currentDriver.uid;
      const urlMap = {
        id: { url: docs.idPhotoUrl, filename: 'id.jpg' as const },
        rc: { url: docs.rcPhotoUrl, filename: 'rc.jpg' as const },
        selfie: { url: docs.selfiePhotoUrl, filename: 'selfie.jpg' as const },
      };
      const target = urlMap[fileKind];
      if (!target) return;

      const opContext = {
        driverUid: uid,
        updatedAtSeconds: currentDriver.updatedAt.seconds,
        updatedAtNanos: currentDriver.updatedAt.nanoseconds,
        selectionSeq: evidenceSeqRef.current.current,
        cancelToken: { isCancelled: false },
      };

      setEvidence((prev) => ({
        ...prev,
        [fileKind]: { ...prev[fileKind], loading: true, error: null },
        allDecoded: false,
      }));

      const fileState = await loadSingleEvidenceFile(
        sessionScope.runtime.storage,
        target.url,
        expectedBucket,
        uid,
        fileKind,
        target.filename,
        () => opContext.cancelToken.isCancelled || activeEvidenceOpRef.current?.cancelToken.isCancelled === true
      );

      if (
        opContext.cancelToken.isCancelled ||
        activeEvidenceOpRef.current?.cancelToken.isCancelled === true ||
        !evidenceSeqRef.current.isCurrent(opContext.selectionSeq) ||
        !isOperationsSessionValid(sessionScope) ||
        selectedDriverRef.current?.uid !== opContext.driverUid ||
        selectedDriverRef.current?.updatedAt?.seconds !== opContext.updatedAtSeconds ||
        selectedDriverRef.current?.updatedAt?.nanoseconds !== opContext.updatedAtNanos
      ) {
        return;
      }

      if (fileState.isAuthDenial) {
        handleFeaturePermissionDenial();
        return;
      }

      setEvidence((prev) => {
        const nextState = { ...prev, [fileKind]: fileState };
        const allDecoded = Boolean(
          nextState.id.dataUrl &&
            nextState.rc.dataUrl &&
            nextState.selfie.dataUrl &&
            !nextState.id.error &&
            !nextState.rc.error &&
            !nextState.selfie.error &&
            nextState.id.generation &&
            nextState.rc.generation &&
            nextState.selfie.generation
        );
        return { ...nextState, allDecoded };
      });
    },
    [sessionScope, handleFeaturePermissionDenial]
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const approveDriver = useCallback(
    async (params: {
      canFlatbed: boolean;
      canPulling: boolean;
      requestId?: string;
      expectedUpdatedAt?: ExactTimestamp;
      expectedSubmittedAt?: ExactTimestamp;
    }) => {
      if (!selectedDriver || !sessionScope || !isOperationsSessionValid(sessionScope)) {
        throw new Error('No valid session or driver selected');
      }
      if (!evidence.allDecoded || !evidence.id.generation || !evidence.rc.generation || !evidence.selfie.generation) {
        throw new Error('All three evidence files must be previewed and decoded before approval');
      }

      const reqId = params.requestId || crypto.randomUUID();
      const existingReq = sessionRequestRegistryRef.current.get(reqId);
      if (existingReq) {
        if (existingReq.driverUid !== selectedDriver.uid) {
          throw new Error('REQUEST_ID_REUSED: A request ID may not be transmitted for a different target');
        }
        const isSame =
          existingReq.operation === 'adminApproveDriver' &&
          existingReq.canFlatbed === params.canFlatbed &&
          existingReq.canPulling === params.canPulling &&
          existingReq.expectedUpdatedAt.seconds === (params.expectedUpdatedAt?.seconds ?? selectedDriver.updatedAt.seconds) &&
          existingReq.expectedUpdatedAt.nanoseconds === (params.expectedUpdatedAt?.nanoseconds ?? selectedDriver.updatedAt.nanoseconds) &&
          existingReq.expectedSubmittedAt.seconds === (params.expectedSubmittedAt?.seconds ?? selectedDriver.verificationDocs!.submittedAt.seconds) &&
          existingReq.expectedSubmittedAt.nanoseconds === (params.expectedSubmittedAt?.nanoseconds ?? selectedDriver.verificationDocs!.submittedAt.nanoseconds) &&
          existingReq.expectedObjectGenerations?.id === evidence.id.generation &&
          existingReq.expectedObjectGenerations?.rc === evidence.rc.generation &&
          existingReq.expectedObjectGenerations?.selfie === evidence.selfie.generation;

        if (!isSame) {
          throw new Error(
            'REQUEST_ID_REUSED: Cannot rebind an existing request ID to a modified payload, version, or evidence generations.'
          );
        }
        if (existingReq.status === 'in_flight') {
          throw new Error('REQUEST_ID_REUSED: Decision request with this ID is already in flight');
        }
        const inFlightReqId = inFlightDriverTargetRef.current.get(selectedDriver.uid);
        if (inFlightReqId && inFlightReqId !== reqId) {
          throw new Error('An unconfirmed decision is already pending for this driver. Use Retry to resend the exact request.');
        }
      } else {
        const inFlightReqId = inFlightDriverTargetRef.current.get(selectedDriver.uid);
        if (inFlightReqId && inFlightReqId !== reqId) {
          throw new Error('An unconfirmed decision is already pending for this driver. Use Retry to resend the exact request.');
        }
      }

      const expUpdated: ExactTimestamp = params.expectedUpdatedAt || {
        seconds: selectedDriver.updatedAt.seconds,
        nanoseconds: selectedDriver.updatedAt.nanoseconds,
      };
      const expSubmitted: ExactTimestamp = params.expectedSubmittedAt || {
        seconds: selectedDriver.verificationDocs!.submittedAt.seconds,
        nanoseconds: selectedDriver.verificationDocs!.submittedAt.nanoseconds,
      };

      const decisionRecord: SubmittedDecision = {
        requestId: reqId,
        driverUid: selectedDriver.uid,
        operation: 'adminApproveDriver',
        expectedUpdatedAt: expUpdated,
        expectedSubmittedAt: expSubmitted,
        canFlatbed: params.canFlatbed,
        canPulling: params.canPulling,
        expectedObjectGenerations: {
          id: evidence.id.generation,
          rc: evidence.rc.generation,
          selfie: evidence.selfie.generation,
        },
        status: 'in_flight',
      };

      sessionRequestRegistryRef.current.set(reqId, { ...decisionRecord });
      inFlightDriverTargetRef.current.set(selectedDriver.uid, reqId);
      setSubmittedDecisions((prev) => new Map(prev).set(selectedDriver.uid, decisionRecord));

      const targetUid = selectedDriver.uid;
      const capturedScope = sessionScope;
      const opToken = ++operationTokenRef.current;
      const capturedReviewEpoch = reviewEpochRef.current;
      const capturedSelectionEpoch = selectionEpochRef.current;
      activeOpTokenByTargetRef.current.set(targetUid, opToken);

      const capturedOwnership = {
        opToken,
        reviewEpoch: capturedReviewEpoch,
        selectionEpoch: capturedSelectionEpoch,
        reqId,
        targetUid,
        sessionScope: capturedScope,
        reviewUpdatedAt: expUpdated,
        reviewSubmittedAt: expSubmitted,
      };

      try {
        const result: DecisionResult = await callAdminApproveDriver(sessionScope.runtime.functions, {
          requestId: reqId,
          driverUid: selectedDriver.uid,
          expectedUpdatedAt: decisionRecord.expectedUpdatedAt,
          expectedSubmittedAt: decisionRecord.expectedSubmittedAt,
          canFlatbed: params.canFlatbed,
          canPulling: params.canPulling,
          expectedObjectGenerations: decisionRecord.expectedObjectGenerations!,
        });

        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          return result;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        const reg = sessionRequestRegistryRef.current.get(reqId);
        if (reg) {
          reg.status = 'committed';
          reg.result = result;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === reqId) {
          inFlightDriverTargetRef.current.delete(targetUid);
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === reqId) {
              return new Map(prev).set(targetUid, {
                ...decisionRecord,
                status: 'committed',
                result,
              });
            }
            return prev;
          });
        }
        return result;
      } catch (err: unknown) {
        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          throw err;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        const msg = err instanceof Error ? err.message : 'Approval failed';
        const reg = sessionRequestRegistryRef.current.get(reqId);
        if (reg) {
          reg.status = 'failed';
          reg.error = msg;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === reqId) {
          if (isDefinitiveFailure(err)) {
            inFlightDriverTargetRef.current.delete(targetUid);
          }
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === reqId) {
              return new Map(prev).set(targetUid, {
                ...decisionRecord,
                status: 'failed',
                error: msg,
              });
            }
            return prev;
          });
        }

        if (isPermissionOrAuthError(err) && isCurrentAttemptAuthorizedForDenial(capturedOwnership)) {
          handleFeaturePermissionDenial();
        }
        throw err;
      }
    },
    [selectedDriver, sessionScope, evidence, handleFeaturePermissionDenial, isCurrentAttemptAuthorizedForDenial]
  );

  const rejectDriver = useCallback(
    async (params: {
      reason: string;
      requestId?: string;
      expectedUpdatedAt?: ExactTimestamp;
      expectedSubmittedAt?: ExactTimestamp;
    }) => {
      if (!selectedDriver || !sessionScope || !isOperationsSessionValid(sessionScope)) {
        throw new Error('No valid session or driver selected');
      }

      const reqId = params.requestId || crypto.randomUUID();
      const existingReq = sessionRequestRegistryRef.current.get(reqId);
      if (existingReq) {
        if (existingReq.driverUid !== selectedDriver.uid) {
          throw new Error('REQUEST_ID_REUSED: A request ID may not be transmitted for a different target');
        }
        const isSame =
          existingReq.operation === 'adminRejectDriver' &&
          existingReq.reason === params.reason &&
          existingReq.expectedUpdatedAt.seconds === (params.expectedUpdatedAt?.seconds ?? selectedDriver.updatedAt.seconds) &&
          existingReq.expectedUpdatedAt.nanoseconds === (params.expectedUpdatedAt?.nanoseconds ?? selectedDriver.updatedAt.nanoseconds) &&
          existingReq.expectedSubmittedAt.seconds === (params.expectedSubmittedAt?.seconds ?? selectedDriver.verificationDocs!.submittedAt.seconds) &&
          existingReq.expectedSubmittedAt.nanoseconds === (params.expectedSubmittedAt?.nanoseconds ?? selectedDriver.verificationDocs!.submittedAt.nanoseconds);

        if (!isSame) {
          throw new Error(
            'REQUEST_ID_REUSED: Cannot rebind an existing request ID to a modified payload, version, or evidence generations.'
          );
        }
        if (existingReq.status === 'in_flight') {
          throw new Error('REQUEST_ID_REUSED: Decision request with this ID is already in flight');
        }
        const inFlightReqId = inFlightDriverTargetRef.current.get(selectedDriver.uid);
        if (inFlightReqId && inFlightReqId !== reqId) {
          throw new Error('An unconfirmed decision is already pending for this driver. Use Retry to resend the exact request.');
        }
      } else {
        const inFlightReqId = inFlightDriverTargetRef.current.get(selectedDriver.uid);
        if (inFlightReqId && inFlightReqId !== reqId) {
          throw new Error('An unconfirmed decision is already pending for this driver. Use Retry to resend the exact request.');
        }
      }

      const expUpdated: ExactTimestamp = params.expectedUpdatedAt || {
        seconds: selectedDriver.updatedAt.seconds,
        nanoseconds: selectedDriver.updatedAt.nanoseconds,
      };
      const expSubmitted: ExactTimestamp = params.expectedSubmittedAt || {
        seconds: selectedDriver.verificationDocs!.submittedAt.seconds,
        nanoseconds: selectedDriver.verificationDocs!.submittedAt.nanoseconds,
      };

      const decisionRecord: SubmittedDecision = {
        requestId: reqId,
        driverUid: selectedDriver.uid,
        operation: 'adminRejectDriver',
        expectedUpdatedAt: expUpdated,
        expectedSubmittedAt: expSubmitted,
        reason: params.reason,
        status: 'in_flight',
      };

      sessionRequestRegistryRef.current.set(reqId, { ...decisionRecord });
      inFlightDriverTargetRef.current.set(selectedDriver.uid, reqId);
      setSubmittedDecisions((prev) => new Map(prev).set(selectedDriver.uid, decisionRecord));

      const targetUid = selectedDriver.uid;
      const capturedScope = sessionScope;
      const opToken = ++operationTokenRef.current;
      const capturedReviewEpoch = reviewEpochRef.current;
      const capturedSelectionEpoch = selectionEpochRef.current;
      activeOpTokenByTargetRef.current.set(targetUid, opToken);

      const capturedOwnership = {
        opToken,
        reviewEpoch: capturedReviewEpoch,
        selectionEpoch: capturedSelectionEpoch,
        reqId,
        targetUid,
        sessionScope: capturedScope,
        reviewUpdatedAt: expUpdated,
        reviewSubmittedAt: expSubmitted,
      };

      try {
        const result: DecisionResult = await callAdminRejectDriver(sessionScope.runtime.functions, {
          requestId: reqId,
          driverUid: selectedDriver.uid,
          expectedUpdatedAt: decisionRecord.expectedUpdatedAt,
          expectedSubmittedAt: decisionRecord.expectedSubmittedAt,
          reason: params.reason,
        });

        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          return result;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        const reg = sessionRequestRegistryRef.current.get(reqId);
        if (reg) {
          reg.status = 'committed';
          reg.result = result;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === reqId) {
          inFlightDriverTargetRef.current.delete(targetUid);
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === reqId) {
              return new Map(prev).set(targetUid, {
                ...decisionRecord,
                status: 'committed',
                result,
              });
            }
            return prev;
          });
        }
        return result;
      } catch (err: unknown) {
        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          throw err;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        const msg = err instanceof Error ? err.message : 'Rejection failed';
        const reg = sessionRequestRegistryRef.current.get(reqId);
        if (reg) {
          reg.status = 'failed';
          reg.error = msg;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === reqId) {
          if (isDefinitiveFailure(err)) {
            inFlightDriverTargetRef.current.delete(targetUid);
          }
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === reqId) {
              return new Map(prev).set(targetUid, {
                ...decisionRecord,
                status: 'failed',
                error: msg,
              });
            }
            return prev;
          });
        }

        if (isPermissionOrAuthError(err) && isCurrentAttemptAuthorizedForDenial(capturedOwnership)) {
          handleFeaturePermissionDenial();
        }
        throw err;
      }
    },
    [selectedDriver, sessionScope, handleFeaturePermissionDenial, isCurrentAttemptAuthorizedForDenial]
  );

  const retryDecision = useCallback(
    async (driverUid: string): Promise<DecisionResult> => {
      const existing = submittedDecisions.get(driverUid);
      if (!existing || !sessionScope || !isOperationsSessionValid(sessionScope)) {
        throw new Error('No in-memory decision available to retry');
      }

      const targetUid = driverUid;
      const capturedScope = sessionScope;
      const opToken = ++operationTokenRef.current;
      const capturedReviewEpoch = reviewEpochRef.current;
      const capturedSelectionEpoch = selectionEpochRef.current;
      activeOpTokenByTargetRef.current.set(targetUid, opToken);

      const curDriver = selectedDriverRef.current;
      const reviewVersion = currentReviewVersionRef.current;
      const reviewUpdatedAt: ExactTimestamp | undefined =
        curDriver && curDriver.uid === targetUid && curDriver.updatedAt
          ? {
              seconds: curDriver.updatedAt.seconds,
              nanoseconds: curDriver.updatedAt.nanoseconds,
            }
          : reviewVersion && reviewVersion.uid === targetUid && reviewVersion.updatedAtSeconds !== undefined
          ? {
              seconds: reviewVersion.updatedAtSeconds,
              nanoseconds: reviewVersion.updatedAtNanos ?? 0,
            }
          : undefined;
      const reviewSubmittedAt: ExactTimestamp | undefined =
        curDriver && curDriver.uid === targetUid && curDriver.verificationDocs?.submittedAt
          ? {
              seconds: curDriver.verificationDocs.submittedAt.seconds,
              nanoseconds: curDriver.verificationDocs.submittedAt.nanoseconds,
            }
          : reviewVersion && reviewVersion.uid === targetUid && reviewVersion.submittedAtSeconds !== undefined
          ? {
              seconds: reviewVersion.submittedAtSeconds,
              nanoseconds: reviewVersion.submittedAtNanos ?? 0,
            }
          : undefined;

      const capturedOwnership = {
        opToken,
        reviewEpoch: capturedReviewEpoch,
        selectionEpoch: capturedSelectionEpoch,
        reqId: existing.requestId,
        targetUid,
        sessionScope: capturedScope,
        reviewUpdatedAt,
        reviewSubmittedAt,
      };

      inFlightDriverTargetRef.current.set(driverUid, existing.requestId);
      const reg = sessionRequestRegistryRef.current.get(existing.requestId);
      if (reg) {
        reg.status = 'in_flight';
      }

      // Resend the EXACT frozen payload without mutating expected timestamps or requestId
      const inFlight: SubmittedDecision = {
        ...existing,
        status: 'in_flight',
        error: undefined,
      };
      setSubmittedDecisions((prev) => new Map(prev).set(driverUid, inFlight));

      try {
        let result: DecisionResult;
        if (existing.operation === 'adminApproveDriver') {
          result = await callAdminApproveDriver(sessionScope.runtime.functions, {
            requestId: existing.requestId,
            driverUid: existing.driverUid,
            expectedUpdatedAt: existing.expectedUpdatedAt,
            expectedSubmittedAt: existing.expectedSubmittedAt,
            canFlatbed: Boolean(existing.canFlatbed),
            canPulling: Boolean(existing.canPulling),
            expectedObjectGenerations: existing.expectedObjectGenerations!,
          });
        } else {
          result = await callAdminRejectDriver(sessionScope.runtime.functions, {
            requestId: existing.requestId,
            driverUid: existing.driverUid,
            expectedUpdatedAt: existing.expectedUpdatedAt,
            expectedSubmittedAt: existing.expectedSubmittedAt,
            reason: existing.reason || '',
          });
        }

        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          return result;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        if (reg) {
          reg.status = 'committed';
          reg.result = result;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === existing.requestId) {
          inFlightDriverTargetRef.current.delete(targetUid);
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === existing.requestId) {
              return new Map(prev).set(targetUid, {
                ...existing,
                status: 'committed',
                result,
              });
            }
            return prev;
          });
        }
        return result;
      } catch (err: unknown) {
        if (!isMountedRef.current || !isOperationsSessionValid(capturedOwnership.sessionScope)) {
          throw err;
        }

        const isCurrentOperation = activeOpTokenByTargetRef.current.get(targetUid) === opToken;
        const msg = err instanceof Error ? err.message : 'Decision retry failed';
        if (reg) {
          reg.status = 'failed';
          reg.error = msg;
        }

        if (isCurrentOperation && inFlightDriverTargetRef.current.get(targetUid) === existing.requestId) {
          if (isDefinitiveFailure(err)) {
            inFlightDriverTargetRef.current.delete(targetUid);
          }
        }

        if (isCurrentOperation) {
          setSubmittedDecisions((prev) => {
            const cur = prev.get(targetUid);
            if (cur && cur.requestId === existing.requestId) {
              return new Map(prev).set(targetUid, {
                ...existing,
                status: 'failed',
                error: msg,
              });
            }
            return prev;
          });
        }

        if (isPermissionOrAuthError(err) && isCurrentAttemptAuthorizedForDenial(capturedOwnership)) {
          handleFeaturePermissionDenial();
        }
        throw err;
      }
    },
    [submittedDecisions, sessionScope, handleFeaturePermissionDenial, isCurrentAttemptAuthorizedForDenial]
  );

  const abandonDecision = useCallback((driverUid: string) => {
    inFlightDriverTargetRef.current.delete(driverUid);
    activeOpTokenByTargetRef.current.delete(driverUid);
    reviewEpochRef.current += 1;
    selectionEpochRef.current += 1;
    setSubmittedDecisions((prev) => {
      const next = new Map(prev);
      next.delete(driverUid);
      return next;
    });
  }, []);

  return {
    statusTab,
    setStatusTab: changeStatusTab,
    drivers: sessionScope ? drivers : [],
    selectedDriverUid,
    setSelectedDriverUid: selectDriver,
    selectedDriver: sessionScope ? selectedDriver : null,
    selectedDriverLoading,
    selectedDriverFromCache,
    selectedDriverError,
    evidence: selectedDriverUid && sessionScope ? evidence : createInitialEvidenceState(),
    evidenceLoading: Boolean(selectedDriverUid && sessionScope && evidenceLoading),
    pageIndex,
    hasMore,
    isLive,
    isLoading,
    lastServerConfirmation,
    isOffline,
    error,
    submittedDecisions,
    goToNextPage,
    goToPreviousPage,
    refresh,
    backToLive,
    approveDriver,
    rejectDriver,
    retryDecision,
    abandonDecision,
    retryEvidenceFile,
  };
}
