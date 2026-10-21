/**
 * TowMitra Phase 6 M2 — Live Jobs Operational Dashboard Service (M2-ARCH-1, Section 5)
 *
 * Implements:
 * - Bounded operational jobs queries (default 4 active states: pending_offer, offered, accepted, in_progress)
 * - Mandatory awaiting_payment filter
 * - Excludes terminal states from list queries
 * - Max 3 listeners per tab (jobs list, selected job, selected current dispatch run)
 * - Single live first page, bounded server snapshots for older pages
 * - On-demand one-shot driver identity reader (at most 2 distinct current drivers)
 * - Strictly read-only: ZERO mutation functions or client writes
 */

import {
  collection,
  doc,
  query,
  where,
  orderBy,
  documentId,
  limit,
  startAfter,
  onSnapshot,
  getDocsFromServer,
  getDocFromServer,
  type Firestore,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  JobRecord,
  JobStatus,
  DispatchRunRecord,
  DriverIdentitySummary,
} from '@/types/operations';

export const DEFAULT_ACTIVE_JOB_STATES: JobStatus[] = [
  'pending_offer',
  'offered',
  'accepted',
  'in_progress',
];

export const PAGE_SIZE = 25;
export const QUERY_LIMIT = PAGE_SIZE + 1; // 26 to detect overflow

// ── 1. Jobs List Queries & Pagination ──────────────────────────────────────

export function buildJobsFirstPageQuery(db: Firestore, selectedFilter: string) {
  if (selectedFilter === 'all_active') {
    return query(
      collection(db, 'jobs'),
      where('status', 'in', DEFAULT_ACTIVE_JOB_STATES),
      orderBy('createdAt', 'desc'),
      orderBy(documentId(), 'desc'),
      limit(QUERY_LIMIT)
    );
  }

  // Single state filter (e.g. awaiting_payment, offered, accepted, etc.)
  return query(
    collection(db, 'jobs'),
    where('status', '==', selectedFilter),
    orderBy('createdAt', 'desc'),
    orderBy(documentId(), 'desc'),
    limit(QUERY_LIMIT)
  );
}

export function buildJobsSnapshotPageQuery(
  db: Firestore,
  selectedFilter: string,
  cursorDoc: QueryDocumentSnapshot
) {
  if (selectedFilter === 'all_active') {
    return query(
      collection(db, 'jobs'),
      where('status', 'in', DEFAULT_ACTIVE_JOB_STATES),
      orderBy('createdAt', 'desc'),
      orderBy(documentId(), 'desc'),
      startAfter(cursorDoc),
      limit(QUERY_LIMIT)
    );
  }

  return query(
    collection(db, 'jobs'),
    where('status', '==', selectedFilter),
    orderBy('createdAt', 'desc'),
    orderBy(documentId(), 'desc'),
    startAfter(cursorDoc),
    limit(QUERY_LIMIT)
  );
}

export interface JobsListSnapshot {
  jobs: JobRecord[];
  snapshots: QueryDocumentSnapshot[];
  hasMore: boolean;
  isFromCache: boolean;
  lastServerConfirmation: Date | null;
}

export function subscribeToJobsFirstPage(
  db: Firestore,
  selectedFilter: string,
  onUpdate: (snapshot: JobsListSnapshot) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = buildJobsFirstPageQuery(db, selectedFilter);
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const docs = snap.docs;
      const hasMore = docs.length > PAGE_SIZE;
      const displayedDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
      const jobs = displayedDocs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<JobRecord, 'id'>),
      }));

      const isFromCache = snap.metadata.fromCache;
      const lastServerConfirmation = isFromCache ? null : new Date();

      onUpdate({
        jobs,
        snapshots: displayedDocs,
        hasMore,
        isFromCache,
        lastServerConfirmation,
      });
    },
    onError
  );
}

export async function fetchJobsSnapshotPage(
  db: Firestore,
  selectedFilter: string,
  cursorDoc: QueryDocumentSnapshot
): Promise<JobsListSnapshot> {
  const q = buildJobsSnapshotPageQuery(db, selectedFilter, cursorDoc);
  const snap = await getDocsFromServer(q);
  const docs = snap.docs;
  const hasMore = docs.length > PAGE_SIZE;
  const displayedDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
  const jobs = displayedDocs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<JobRecord, 'id'>),
  }));

  return {
    jobs,
    snapshots: displayedDocs,
    hasMore,
    isFromCache: false,
    lastServerConfirmation: new Date(),
  };
}

// ── 2. Selected Job Detail & Linked Dispatch Run ───────────────────────────

export function subscribeToJobDetail(
  db: Firestore,
  jobId: string,
  onUpdate: (job: JobRecord | null, isFromCache: boolean) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const docRef = doc(db, 'jobs', jobId);
  return onSnapshot(
    docRef,
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null, snap.metadata.fromCache);
        return;
      }
      const data = snap.data() as Omit<JobRecord, 'id'>;
      onUpdate({ id: snap.id, ...data }, snap.metadata.fromCache);
    },
    onError
  );
}

export function subscribeToDispatchRun(
  db: Firestore,
  jobId: string,
  runId: string,
  onUpdate: (run: DispatchRunRecord | null, isFromCache: boolean) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const docRef = doc(db, 'jobs', jobId, 'dispatch_runs', runId);
  return onSnapshot(
    docRef,
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null, snap.metadata.fromCache);
        return;
      }
      const data = snap.data() as Omit<DispatchRunRecord, 'id'>;
      onUpdate({ id: snap.id, ...data }, snap.metadata.fromCache);
    },
    onError
  );
}

// ── 3. On-Demand Driver Identity Reader ─────────────────────────────────────

export function isPermissionOrAuthError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'permission-denied' ||
    e.code === 'unauthenticated' ||
    (typeof e.message === 'string' &&
      (e.message.includes('permission-denied') ||
        e.message.includes('unauthenticated') ||
        e.message.includes('insufficient permissions')))
  );
}

export async function fetchDriverIdentity(
  db: Firestore,
  driverUid: string
): Promise<DriverIdentitySummary | null> {
  if (!driverUid || typeof driverUid !== 'string') return null;
  try {
    const docRef = doc(db, 'drivers', driverUid);
    const snap = await getDocFromServer(docRef);
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      uid: snap.id,
      name: String(data.name || 'Unknown Driver'),
      phone: String(data.phone || 'Unavailable'),
      vehicleNumber: String(data.vehicleNumber || 'Unavailable'),
      truckType: String(data.truckType || 'Unavailable'),
      lastFetchedAt: new Date(),
    };
  } catch (err: unknown) {
    if (isPermissionOrAuthError(err)) {
      throw err;
    }
    return null;
  }
}

// ── 4. Formatting Utilities ────────────────────────────────────────────────

export function formatPaiseToRupees(paise?: number): string {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise) || paise < 0) {
    return 'Unavailable';
  }
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(rupees);
}

export function maskPhoneNumber(phone?: string): string {
  if (!phone || typeof phone !== 'string') return 'Unavailable';
  const clean = phone.trim();
  if (clean.length < 8) return clean;
  // Show first 3 and last 3 characters
  return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
}
