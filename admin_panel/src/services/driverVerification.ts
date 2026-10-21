/**
 * TowMitra Phase 6 M2 — Driver Verification Service (M2-ARCH-1, Section 3)
 *
 * Implements:
 * - Bounded queries (verificationStatus == status, orderBy createdAt ASC, documentId ASC, limit 26)
 * - Single live first page, bounded one-shot snapshot older pages
 * - Single document listener for selected driver
 * - Canonical authenticated private evidence loader (getMetadata -> getBytes -> getMetadata)
 * - Generation stability, 10MB bounds, image MIME check, in-memory data URL decoding
 * - Max 3 outstanding file download chains across selection/session changes
 * - Cloud Function callable adapters for adminApproveDriver & adminRejectDriver
 * - Strictly NO direct browser writes to protected driver fields or admin_actions
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
  type Firestore,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  ref,
  getMetadata,
  getBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  httpsCallable,
  type Functions,
} from 'firebase/functions';
import type {
  DriverProfile,
  VerificationStatus,
  EvidenceFileState,
  EvidenceState,
  DecisionResult,
  ExactTimestamp,
} from '@/types/operations';

export const PAGE_SIZE = 25;
export const QUERY_LIMIT = PAGE_SIZE + 1; // 26 to detect overflow

// ── 1. Bounded Driver Queries ──────────────────────────────────────────────

export function buildFirstPageQuery(db: Firestore, status: VerificationStatus) {
  return query(
    collection(db, 'drivers'),
    where('verificationStatus', '==', status),
    orderBy('createdAt', 'asc'),
    orderBy(documentId(), 'asc'),
    limit(QUERY_LIMIT)
  );
}

export function buildSnapshotPageQuery(
  db: Firestore,
  status: VerificationStatus,
  cursorDoc: QueryDocumentSnapshot
) {
  return query(
    collection(db, 'drivers'),
    where('verificationStatus', '==', status),
    orderBy('createdAt', 'asc'),
    orderBy(documentId(), 'asc'),
    startAfter(cursorDoc),
    limit(QUERY_LIMIT)
  );
}

export interface DriverListSnapshot {
  drivers: DriverProfile[];
  snapshots: QueryDocumentSnapshot[];
  hasMore: boolean;
  isFromCache: boolean;
  lastServerConfirmation: Date | null;
}

export function subscribeToFirstPage(
  db: Firestore,
  status: VerificationStatus,
  onUpdate: (snapshot: DriverListSnapshot) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = buildFirstPageQuery(db, status);
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const docs = snap.docs;
      const hasMore = docs.length > PAGE_SIZE;
      const displayedDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
      const drivers = displayedDocs.map((d) => ({
        uid: d.id,
        ...(d.data() as Omit<DriverProfile, 'uid'>),
      }));

      const isFromCache = snap.metadata.fromCache;
      const lastServerConfirmation = isFromCache ? null : new Date();

      onUpdate({
        drivers,
        snapshots: displayedDocs,
        hasMore,
        isFromCache,
        lastServerConfirmation,
      });
    },
    onError
  );
}

export async function fetchSnapshotPage(
  db: Firestore,
  status: VerificationStatus,
  cursorDoc: QueryDocumentSnapshot
): Promise<DriverListSnapshot> {
  const q = buildSnapshotPageQuery(db, status, cursorDoc);
  const snap = await getDocsFromServer(q);
  const docs = snap.docs;
  const hasMore = docs.length > PAGE_SIZE;
  const displayedDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
  const drivers = displayedDocs.map((d) => ({
    uid: d.id,
    ...(d.data() as Omit<DriverProfile, 'uid'>),
  }));

  return {
    drivers,
    snapshots: displayedDocs,
    hasMore,
    isFromCache: false,
    lastServerConfirmation: new Date(),
  };
}

export function subscribeToDriverDetail(
  db: Firestore,
  driverUid: string,
  onUpdate: (driver: DriverProfile | null, isFromCache: boolean) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const docRef = doc(db, 'drivers', driverUid);
  return onSnapshot(
    docRef,
    { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) {
        onUpdate(null, snap.metadata.fromCache);
        return;
      }
      const data = snap.data() as Omit<DriverProfile, 'uid'>;
      onUpdate({ uid: snap.id, ...data }, snap.metadata.fromCache);
    },
    onError
  );
}

// ── 2. Authenticated Evidence Loader & Queue ───────────────────────────────

class EvidenceDownloadQueue {
  private activeCount = 0;
  private maxConcurrent = 3;
  private queue: Array<() => Promise<void>> = [];

  public enqueue<T>(task: () => Promise<T>, isCancelled?: () => boolean, cancelValue?: T): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        if (isCancelled && isCancelled()) {
          if (cancelValue !== undefined) {
            resolve(cancelValue);
          } else {
            reject(new Error('Operation cancelled'));
          }
          this.processNext();
          return;
        }

        this.activeCount++;
        try {
          if (isCancelled && isCancelled()) {
            if (cancelValue !== undefined) {
              resolve(cancelValue);
            } else {
              reject(new Error('Operation cancelled'));
            }
            return;
          }
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        } finally {
          this.activeCount--;
          this.processNext();
        }
      };

      if (this.activeCount < this.maxConcurrent) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }

  private processNext() {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  public clear() {
    this.queue = [];
  }
}

export const evidenceQueue = new EvidenceDownloadQueue();

export function validateCanonicalStoragePath(
  gsUrl: string,
  expectedBucket: string,
  driverUid: string,
  expectedFilename: string
): string | null {
  if (typeof gsUrl !== 'string' || !gsUrl.startsWith('gs://')) {
    return null;
  }
  const withoutPrefix = gsUrl.slice(5);
  const firstSlash = withoutPrefix.indexOf('/');
  if (firstSlash === -1) return null;

  const bucketName = withoutPrefix.slice(0, firstSlash);
  const path = withoutPrefix.slice(firstSlash + 1);

  if (bucketName !== expectedBucket) return null;

  const expectedPath = `driver_verification/${driverUid}/${expectedFilename}`;
  if (path !== expectedPath) return null;

  return path;
}

function bufferToDataUrl(buffer: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function verifyImageDecodable(dataUrl: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return true; // Non-browser / Node testing environment
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

export function isStorageAuthDenial(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string; message?: string; status_?: number; serverResponse_?: string };
  return (
    e.code === 'storage/unauthorized' ||
    e.code === 'permission-denied' ||
    e.code === 'unauthenticated' ||
    e.status_ === 403 ||
    e.status_ === 401 ||
    (typeof e.message === 'string' &&
      (e.message.includes('storage/unauthorized') ||
        e.message.includes('permission-denied') ||
        e.message.includes('unauthorized') ||
        e.message.includes('unauthenticated') ||
        e.message.includes('insufficient permissions')))
  );
}

export async function loadSingleEvidenceFile(
  storage: FirebaseStorage,
  gsUrl: string,
  expectedBucket: string,
  driverUid: string,
  docKey: 'id' | 'rc' | 'selfie',
  filename: 'id.jpg' | 'rc.jpg' | 'selfie.jpg',
  isCancelled?: () => boolean
): Promise<EvidenceFileState> {
  const cancelledState: EvidenceFileState = {
    docKey,
    filename,
    url: gsUrl,
    dataUrl: null,
    generation: null,
    size: 0,
    contentType: '',
    loading: false,
    error: 'Evidence loading cancelled',
  };

  if (isCancelled && isCancelled()) {
    return cancelledState;
  }

  const relPath = validateCanonicalStoragePath(gsUrl, expectedBucket, driverUid, filename);
  if (!relPath) {
    return {
      docKey,
      filename,
      url: gsUrl,
      dataUrl: null,
      generation: null,
      size: 0,
      contentType: '',
      loading: false,
      error: 'Invalid canonical Storage path or bucket mismatch',
    };
  }

  return await evidenceQueue.enqueue(
    async () => {
      if (isCancelled && isCancelled()) return cancelledState;
      try {
        const storageRef = ref(storage, relPath);

        // Metadata check 1 before download
        const meta1 = await getMetadata(storageRef);
        if (isCancelled && isCancelled()) return cancelledState;
        const gen1 = String(meta1.generation || '');
        const contentType = String(meta1.contentType || '');
        const size1 = Number(meta1.size || 0);

        if (!contentType.startsWith('image/')) {
          return {
            docKey,
            filename,
            url: gsUrl,
            dataUrl: null,
            generation: null,
            size: size1,
            contentType,
            loading: false,
            error: `Disallowed MIME type: ${contentType}`,
          };
        }

        if (size1 <= 0 || size1 > 10 * 1024 * 1024) {
          return {
            docKey,
            filename,
            url: gsUrl,
            dataUrl: null,
            generation: null,
            size: size1,
            contentType,
            loading: false,
            error: `File size exceeds 10 MiB limit: ${size1} bytes`,
          };
        }

        // Download bounded bytes (10MB max)
        const buffer = await getBytes(storageRef, 10 * 1024 * 1024);
        if (isCancelled && isCancelled()) return cancelledState;

        // Metadata check 2 after download to ensure generation stability
        const meta2 = await getMetadata(storageRef);
        if (isCancelled && isCancelled()) return cancelledState;
        const gen2 = String(meta2.generation || '');

        if (!gen1 || gen1 !== gen2) {
          return {
            docKey,
            filename,
            url: gsUrl,
            dataUrl: null,
            generation: null,
            size: size1,
            contentType,
            loading: false,
            error: 'Evidence generation changed during preview download',
          };
        }

        const dataUrl = bufferToDataUrl(buffer, contentType);
        const decodable = await verifyImageDecodable(dataUrl);
        if (!decodable) {
          return {
            docKey,
            filename,
            url: gsUrl,
            dataUrl: null,
            generation: null,
            size: size1,
            contentType,
            loading: false,
            error: 'Image bytes could not be decoded',
          };
        }

        return {
          docKey,
          filename,
          url: gsUrl,
          dataUrl,
          generation: gen1,
          size: size1,
          contentType,
          loading: false,
          error: null,
        };
      } catch (err: unknown) {
        const isAuth = isStorageAuthDenial(err);
        const msg = err instanceof Error ? err.message : 'Failed to load evidence file';
        return {
          docKey,
          filename,
          url: gsUrl,
          dataUrl: null,
          generation: null,
          size: 0,
          contentType: '',
          loading: false,
          error: isAuth ? 'Storage read permission denied' : msg,
          isAuthDenial: isAuth,
        };
      }
    },
    isCancelled,
    cancelledState
  );
}

export function createInitialEvidenceState(): EvidenceState {
  return {
    id: { docKey: 'id', filename: 'id.jpg', url: '', dataUrl: null, generation: null, size: 0, contentType: '', loading: false, error: null },
    rc: { docKey: 'rc', filename: 'rc.jpg', url: '', dataUrl: null, generation: null, size: 0, contentType: '', loading: false, error: null },
    selfie: { docKey: 'selfie', filename: 'selfie.jpg', url: '', dataUrl: null, generation: null, size: 0, contentType: '', loading: false, error: null },
    allDecoded: false,
  };
}

// ── 3. Callable Decision Invocation ────────────────────────────────────────

export interface ApproveDriverInput {
  requestId: string;
  driverUid: string;
  expectedUpdatedAt: ExactTimestamp;
  expectedSubmittedAt: ExactTimestamp;
  canFlatbed: boolean;
  canPulling: boolean;
  expectedObjectGenerations: {
    id: string;
    rc: string;
    selfie: string;
  };
}

export interface RejectDriverInput {
  requestId: string;
  driverUid: string;
  expectedUpdatedAt: ExactTimestamp;
  expectedSubmittedAt: ExactTimestamp;
  reason: string;
}

export async function callAdminApproveDriver(
  functions: Functions,
  input: ApproveDriverInput
): Promise<DecisionResult> {
  const callable = httpsCallable<ApproveDriverInput, DecisionResult>(functions, 'adminApproveDriver');
  const res = await callable(input);
  return res.data;
}

export async function callAdminRejectDriver(
  functions: Functions,
  input: RejectDriverInput
): Promise<DecisionResult> {
  const callable = httpsCallable<RejectDriverInput, DecisionResult>(functions, 'adminRejectDriver');
  const res = await callable(input);
  return res.data;
}
