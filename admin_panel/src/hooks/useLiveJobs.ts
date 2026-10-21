/**
 * TowMitra Phase 6 M2 — Live Jobs Operational Hook (M2-ARCH-1, Section 5 & 6)
 *
 * Responsibilities:
 * - Route/filter-scoped subscriptions (max 3 stable Firestore listeners: list + selected job + current dispatch run)
 * - Default active filter ('all_active') covers: pending_offer, offered, accepted, in_progress
 * - Mandatory awaiting_payment filter
 * - Selected job listener survives row removal so terminal transitions remain visible
 * - Detach-before-attach for dispatch run listener on run/generation pointer change
 * - Immediately invalidates stale run data and pointer upon pointer change or removal
 * - Canonical pagination cursor stack for Previous page navigation
 * - On-demand identity fetching with pointer invalidation
 * - Synchronously clears state, listeners, and calls auth refresh on permission denial or unmount
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { QueryDocumentSnapshot, Unsubscribe } from 'firebase/firestore';
import { useAuth } from '@/context/AuthContext';
import {
  getAuthorizedOperationsSession,
  isOperationsSessionValid,
  SequenceTracker,
} from '@/services/operationsSession';
import {
  subscribeToJobsFirstPage,
  fetchJobsSnapshotPage,
  subscribeToJobDetail,
  subscribeToDispatchRun,
  fetchDriverIdentity,
  type JobsListSnapshot,
} from '@/services/liveJobs';
import type {
  JobRecord,
  DispatchRunRecord,
  DriverIdentitySummary,
} from '@/types/operations';
import { isPermissionOrAuthError } from './useVerificationQueue';

export function useLiveJobs() {
  const authContext = useAuth();
  const sessionScope = useMemo(() => getAuthorizedOperationsSession(authContext), [authContext]);

  const [selectedFilter, setSelectedFilter] = useState<string>('all_active');
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [selectedJobLoading, setSelectedJobLoading] = useState(false);
  const [selectedJobFromCache, setSelectedJobFromCache] = useState(false);

  const [selectedRun, setSelectedRun] = useState<DispatchRunRecord | null>(null);
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);

  // On-demand driver identities (UID -> Summary)
  const [driverIdentities, setDriverIdentities] = useState<Map<string, DriverIdentitySummary>>(
    () => new Map()
  );
  const [identityLoading, setIdentityLoading] = useState(false);

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

  // Cursors stack for backward pagination
  const cursorStackRef = useRef<QueryDocumentSnapshot[]>([]);
  const currentSnapshotsRef = useRef<QueryDocumentSnapshot[]>([]);

  // Sequence trackers
  const listSeqRef = useRef(new SequenceTracker());
  const jobSeqRef = useRef(new SequenceTracker());
  const runSeqRef = useRef(new SequenceTracker());
  const identitySeqRef = useRef(new SequenceTracker());

  // Listeners
  const listUnsubRef = useRef<Unsubscribe | null>(null);
  const jobUnsubRef = useRef<Unsubscribe | null>(null);
  const runUnsubRef = useRef<Unsubscribe | null>(null);
  const selectedJobRef = useRef<JobRecord | null>(null);
  const selectedRunRef = useRef<DispatchRunRecord | null>(null);

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
    setJobs([]);
    setSelectedJob(null);
    setSelectedJobId(null);
    setSelectedRun(null);
    setDriverIdentities(new Map());
    listSeqRef.current.next();
    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();
    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }
    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }
    authContext.refreshAuthorization();
  }, [authContext]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      if (listUnsubRef.current) {
        listUnsubRef.current();
        listUnsubRef.current = null;
      }
      if (jobUnsubRef.current) {
        jobUnsubRef.current();
        jobUnsubRef.current = null;
      }
      if (runUnsubRef.current) {
        runUnsubRef.current();
        runUnsubRef.current = null;
      }
    };
  }, []);

  // ── Attach First Page Listener ────────────────────────────────────────────

  const refresh = useCallback(() => {
    if (!sessionScope || !isOperationsSessionValid(sessionScope)) return;

    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();

    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }
    if (listUnsubRef.current) {
      listUnsubRef.current();
      listUnsubRef.current = null;
    }

    selectedJobRef.current = null;
    selectedRunRef.current = null;

    setSelectedJobId(null);
    setSelectedJob(null);
    setSelectedRun(null);
    setDriverIdentities(new Map());

    const seq = listSeqRef.current.next();
    setIsLoading(true);
    setError(null);
    setPageIndex(0);
    cursorStackRef.current = [];

    listUnsubRef.current = subscribeToJobsFirstPage(
      sessionScope.runtime.db,
      selectedFilter,
      (snap: JobsListSnapshot) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setJobs(snap.jobs);
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
        setError(err.message || 'Failed to load live jobs');
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );
  }, [sessionScope, selectedFilter, handleFeaturePermissionDenial]);

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
    const unsub = subscribeToJobsFirstPage(
      sessionScope.runtime.db,
      selectedFilter,
      (snap: JobsListSnapshot) => {
        if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setJobs(snap.jobs);
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
        setError(err.message || 'Failed to load live jobs');
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
  }, [sessionScope, selectedFilter, handleFeaturePermissionDenial]);

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

    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();
    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }
    selectedJobRef.current = null;
    selectedRunRef.current = null;
    setSelectedJobId(null);
    setSelectedJob(null);
    setSelectedRun(null);
    setDriverIdentities(new Map());
    setIdentityLoading(false);

    const seq = listSeqRef.current.next();
    setIsLoading(true);

    try {
      const snap = await fetchJobsSnapshotPage(sessionScope.runtime.db, selectedFilter, nextCursor);
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      setJobs(snap.jobs);
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
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs page');
      if (isPermissionOrAuthError(err)) {
        handleFeaturePermissionDenial();
      }
    }
  }, [sessionScope, hasMore, selectedFilter, handleFeaturePermissionDenial]);

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

    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();
    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }
    selectedJobRef.current = null;
    selectedRunRef.current = null;
    setSelectedJobId(null);
    setSelectedJob(null);
    setSelectedRun(null);
    setDriverIdentities(new Map());
    setIdentityLoading(false);

    const seq = listSeqRef.current.next();
    setIsLoading(true);

    try {
      const snap = await fetchJobsSnapshotPage(sessionScope.runtime.db, selectedFilter, prevCursor);
      if (!listSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
      setJobs(snap.jobs);
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
      setError(err instanceof Error ? err.message : 'Failed to fetch previous jobs page');
      if (isPermissionOrAuthError(err)) {
        handleFeaturePermissionDenial();
      }
    }
  }, [sessionScope, pageIndex, refresh, selectedFilter, handleFeaturePermissionDenial]);

  // Safe handler to change filter and clear selection
  const changeFilter = useCallback((newFilter: string) => {
    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();

    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }

    selectedJobRef.current = null;
    selectedRunRef.current = null;

    setSelectedFilter(newFilter);
    setSelectedJobId(null);
    setSelectedJob(null);
    setSelectedRun(null);
    setDriverIdentities(new Map());
    setIdentityLoading(false);
    setPageIndex(0);
    cursorStackRef.current = [];
  }, []);

  const selectJob = useCallback((id: string | null) => {
    jobSeqRef.current.next();
    runSeqRef.current.next();
    identitySeqRef.current.next();

    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }

    selectedJobRef.current = null;
    selectedRunRef.current = null;

    setSelectedJobId(id);
    setSelectedRun(null);
    setDriverIdentities(new Map());
    setIdentityLoading(false);
    setSelectedJob(null);
    setSelectedJobLoading(Boolean(id));
  }, []);

  // Render-phase adjustments to avoid setState inside effect bodies
  const [prevSelectedJobId, setPrevSelectedJobId] = useState<string | null>(null);
  if (selectedJobId !== prevSelectedJobId) {
    setPrevSelectedJobId(selectedJobId);
    setSelectedJob(null);
    setSelectedJobLoading(Boolean(selectedJobId));
  }

  if ((!selectedJobId || !sessionScope || !isOperationsSessionValid(sessionScope)) && selectedJobLoading) {
    setSelectedJobLoading(false);
  }

  // ── Selected Job Listener (survives row exit) ─────────────────────────────

  useEffect(() => {
    if (jobUnsubRef.current) {
      jobUnsubRef.current();
      jobUnsubRef.current = null;
    }

    if (!selectedJobId || !sessionScope || !isOperationsSessionValid(sessionScope)) {
      jobSeqRef.current.next();
      selectedJobRef.current = null;
      return;
    }

    const currentExpectedJobId = selectedJobId;
    const seq = jobSeqRef.current.next();
    const unsub = subscribeToJobDetail(
      sessionScope.runtime.db,
      currentExpectedJobId,
      (job: JobRecord | null, isFromCache: boolean) => {
        if (!jobSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        if (job && job.id !== currentExpectedJobId) return;

        // Invalidate identity sequence if pointer changes or generation changes
        const prev = selectedJobRef.current;
        if (
          prev &&
          job &&
          (prev.id !== job.id ||
            prev.offeredTo !== job.offeredTo ||
            prev.assignedDriver !== job.assignedDriver ||
            prev.currentOfferId !== job.currentOfferId ||
            prev.dispatchRunId !== job.dispatchRunId ||
            prev.dispatchGeneration !== job.dispatchGeneration)
        ) {
          identitySeqRef.current.next();
          setDriverIdentities(new Map());
          setIdentityLoading(false);
        } else if (!job) {
          identitySeqRef.current.next();
          setDriverIdentities(new Map());
          setIdentityLoading(false);
        }
        selectedJobRef.current = job;
        setSelectedJob(job);
        setSelectedJobLoading(false);
        setSelectedJobFromCache(isFromCache);
      },
      (err: Error) => {
        if (!jobSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        setSelectedJobLoading(false);
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );

    jobUnsubRef.current = unsub;
    const jobSeq = jobSeqRef.current;
    return () => {
      jobSeq.next();
      if (jobUnsubRef.current) {
        jobUnsubRef.current();
        jobUnsubRef.current = null;
      }
    };
  }, [selectedJobId, sessionScope, handleFeaturePermissionDenial]);

  // ── Linked Dispatch Run Listener (detach before attach) ───────────────────

  const currentRunId = selectedJob?.dispatchRunId || selectedJob?.currentDispatchRunId;
  const currentJobId = selectedJob?.id;
  const currentGeneration = selectedJob?.dispatchGeneration;

  const currentRunKey = currentJobId && currentRunId ? `${currentJobId}_${currentRunId}_${currentGeneration}` : null;
  const [prevRunKey, setPrevRunKey] = useState<string | null>(null);
  if (currentRunKey !== prevRunKey) {
    setPrevRunKey(currentRunKey);
    setSelectedRun(null);
    setSelectedRunLoading(Boolean(currentRunKey));
  }

  if ((!currentRunId || !currentJobId || !sessionScope || !isOperationsSessionValid(sessionScope)) && selectedRunLoading) {
    setSelectedRunLoading(false);
  }

  useEffect(() => {
    if (runUnsubRef.current) {
      runUnsubRef.current();
      runUnsubRef.current = null;
    }

    selectedRunRef.current = null;

    if (!currentRunId || !currentJobId || !sessionScope || !isOperationsSessionValid(sessionScope)) {
      runSeqRef.current.next();
      return;
    }

    const expectedJobId = currentJobId;
    const expectedRunId = currentRunId;
    const expectedGen = currentGeneration;
    const seq = runSeqRef.current.next();

    const unsub = subscribeToDispatchRun(
      sessionScope.runtime.db,
      expectedJobId,
      expectedRunId,
      (run: DispatchRunRecord | null) => {
        if (
          !runSeqRef.current.isCurrent(seq) ||
          !isOperationsSessionValid(sessionScope) ||
          !run ||
          run.jobId !== expectedJobId ||
          run.id !== expectedRunId
        ) {
          if (runSeqRef.current.isCurrent(seq)) {
            selectedRunRef.current = null;
            setSelectedRun(null);
            setSelectedRunLoading(false);
          }
          return;
        }
        // Validate run identity against current job and generation
        const runGen = run.generation !== undefined ? run.generation : run.dispatchGeneration;
        if (expectedGen !== undefined && runGen !== undefined && runGen !== expectedGen) {
          selectedRunRef.current = null;
          setSelectedRun(null);
          setSelectedRunLoading(false);
          return;
        }
        selectedRunRef.current = run;
        setSelectedRun(run);
        setSelectedRunLoading(false);
      },
      (err: Error) => {
        if (!runSeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;
        selectedRunRef.current = null;
        setSelectedRun(null);
        setSelectedRunLoading(false);
        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      }
    );

    runUnsubRef.current = unsub;
    const runSeq = runSeqRef.current;
    return () => {
      runSeq.next();
      if (runUnsubRef.current) {
        runUnsubRef.current();
        runUnsubRef.current = null;
      }
    };
  }, [currentJobId, currentRunId, currentGeneration, sessionScope, handleFeaturePermissionDenial]);

  // ── On-Demand Linked Driver Identity Fetcher ──────────────────────────────

  const loadDriverIdentity = useCallback(
    async (driverUid: string) => {
      if (!driverUid || !sessionScope || !isOperationsSessionValid(sessionScope)) return;
      const currentJob = selectedJobRef.current;
      const expectedJobId = currentJob?.id;
      const expectedGen = currentJob?.dispatchGeneration;
      const expectedRunId = currentJob?.dispatchRunId || currentJob?.currentDispatchRunId;

      const seq = identitySeqRef.current.next();
      setIdentityLoading(true);

      try {
        const summary = await fetchDriverIdentity(sessionScope.runtime.db, driverUid);
        if (!identitySeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) return;

        // Fence returned identity: verify current job selection and generation haven't changed
        const latestJob = selectedJobRef.current;
        const latestRunId = latestJob?.dispatchRunId || latestJob?.currentDispatchRunId;
        if (
          !latestJob ||
          latestJob.id !== expectedJobId ||
          latestJob.dispatchGeneration !== expectedGen ||
          latestRunId !== expectedRunId
        ) {
          return;
        }

        const isStillRelevant =
          latestJob.offeredTo === driverUid ||
          latestJob.assignedDriver === driverUid ||
          (selectedRunRef.current?.candidates &&
            selectedRunRef.current.candidates.some((c) => c.driverId === driverUid));

        if (!isStillRelevant) {
          return;
        }

        if (summary) {
          setDriverIdentities((prev) => new Map(prev).set(driverUid, summary));
        } else {
          setDriverIdentities((prev) => {
            const next = new Map(prev);
            next.delete(driverUid);
            return next;
          });
        }
      } catch (err: unknown) {
        if (!identitySeqRef.current.isCurrent(seq) || !isOperationsSessionValid(sessionScope)) {
          return;
        }

        const latestJob = selectedJobRef.current;
        const latestRunId = latestJob?.dispatchRunId || latestJob?.currentDispatchRunId;
        if (
          !latestJob ||
          latestJob.id !== expectedJobId ||
          latestJob.dispatchGeneration !== expectedGen ||
          latestRunId !== expectedRunId
        ) {
          return;
        }

        const isStillRelevant =
          latestJob.offeredTo === driverUid ||
          latestJob.assignedDriver === driverUid ||
          (selectedRunRef.current?.candidates &&
            selectedRunRef.current.candidates.some((c) => c.driverId === driverUid));

        if (!isStillRelevant) {
          return;
        }

        if (isPermissionOrAuthError(err)) {
          handleFeaturePermissionDenial();
        }
      } finally {
        if (identitySeqRef.current.isCurrent(seq)) {
          setIdentityLoading(false);
        }
      }
    },
    [sessionScope, handleFeaturePermissionDenial]
  );

  const isCurrentRunMatching = Boolean(
    selectedJob &&
      selectedRun &&
      currentRunId &&
      selectedRun.jobId === selectedJob.id &&
      selectedRun.id === currentRunId &&
      (currentGeneration === undefined ||
        selectedRun.generation === currentGeneration ||
        selectedRun.dispatchGeneration === currentGeneration)
  );

  return {
    selectedFilter,
    setSelectedFilter: changeFilter,
    jobs: sessionScope ? jobs : [],
    selectedJobId,
    setSelectedJobId: selectJob,
    selectedJob: sessionScope ? selectedJob : null,
    selectedJobLoading,
    selectedJobFromCache,
    selectedRun: isCurrentRunMatching && sessionScope ? selectedRun : null,
    selectedRunLoading: Boolean(currentRunId && !isCurrentRunMatching && sessionScope && selectedRunLoading),
    driverIdentities,
    identityLoading,
    pageIndex,
    hasMore,
    isLive,
    isLoading,
    lastServerConfirmation,
    isOffline,
    error,
    goToNextPage,
    goToPreviousPage,
    refresh,
    backToLive,
    loadDriverIdentity,
  };
}
