'use strict';

const { getFirestore, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { createDispatchService } = require('./dispatchService');
const { DispatchError, positive, timestampMillis, exactKeys } = require('./dispatchValidation');
const { createOlaMapsClient } = require('../services/olaMapsClient');
const { createOfferTimeoutManager } = require('./offerTimeout');
const { createTaskQueueService } = require('../services/taskQueueService');

function createDispatchRecovery({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  service = createDispatchService({ db, TimestampClass, now }),
  timeoutManager = null,
  taskQueueService = null,
  batchSize = 50,
} = {}) {
  if (!positive(batchSize)) throw new DispatchError('RUNTIME_CONFIG_INVALID');
  const taskQueue = taskQueueService || service.taskQueueService || createTaskQueueService();
  const timeoutMgr = timeoutManager || service.timeoutManager || createOfferTimeoutManager({
    db, TimestampClass, now, dispatchService: service, taskQueueService: taskQueue,
  });

  async function consumePendingJob(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists || after.data().status !== 'pending_offer') return;
    const previous = before?.exists ? before.data() : null;
    // No feedback loop from claim/selecting/retry metadata writes. Scheduler
    // owns due retries and expired leases; ready transitions are accelerators.
    if (previous?.status === 'pending_offer' &&
        !(after.data().dispatchState === 'ready' && previous.dispatchState !== 'ready')) return;
    return service.processDispatchJob(event.params.jobId);
  }

  // Stage 2 scheduled recovery: processes pending_offer backlog and retry_wait jobs.
  async function reconcilePendingJobs() {
    let last = null;
    const counts = { discovered: 0, offered: 0, exhausted: 0, deferred: 0, failed: 0, reasons: {} };
    do {
      // Status is the ONLY predicate. Default document-ID pagination includes
      // legacy jobs missing every Phase 4 field, and cannot starve behind holds.
      let query = db.collection('jobs').where('status', '==', 'pending_offer').limit(batchSize);
      if (last) query = query.startAfter(last);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        counts.discovered++;
        try {
          const result = await service.processDispatchJob(doc.id);
          if (result.dispatched) counts.offered++;
          else if (result.exhausted) counts.exhausted++;
          else {
            counts.deferred++;
            // Only fixed worker result codes; never exceptions/provider bodies.
            const reason = typeof result.reason === 'string' && /^[A-Z_]{1,64}$/.test(result.reason) ? result.reason : 'DEFERRED';
            counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
          }
        } catch { counts.failed++; }
      }
      last = page.docs[page.docs.length - 1];
      if (page.size < batchSize) break;
    } while (last);

    // Continue past individual failures before surfacing failure to Scheduler.
    if (counts.failed) throw new DispatchError('RECOVERY_INCOMPLETE', { retryable: true });
    return counts;
  }

  // Stage 3 scheduled recovery: independently bounded recovery for due-offer expiration
  // and pending timeout task enqueue, backed by durable sweep checkpoints.
  async function reconcileOfferTimeouts({
    maxDueOffers = batchSize,
    maxPendingEnqueues = batchSize,
    maxDueScanned = maxDueOffers,
    maxPendingScanned = maxPendingEnqueues,
    maxDueScannedPerInvocation = maxDueScanned,
    maxPendingScannedPerInvocation = maxPendingScanned,
    dueBatchSize = maxDueScannedPerInvocation,
    enqueueBatchSize = maxPendingScannedPerInvocation,
    checkpointDocPath = 'dispatch_config/recovery_checkpoints',
  } = {}) {
    const counts = {
      discoveredDue: 0,
      expired: 0,
      discoveredPending: 0,
      markerConverged: 0,
      failed: 0,
      dueScanned: 0,
      pendingScanned: 0,
    };
    const nowMs = now().getTime();
    const nowTimestamp = TimestampClass.fromMillis(nowMs);
    const maxTimestamp = new TimestampClass(253402300799, 999999999);
    const minTimestamp = new TimestampClass(0, 0);

    const checkpointRef = db.doc(checkpointDocPath);

    // Bootstrap or load validated checkpoint
    let checkpoint;
    try {
      checkpoint = await getOrBootstrapCheckpoint(db, checkpointRef, TimestampClass, nowMs);
    } catch (err) {
      counts.failed++;
      throw err;
    }

    // ==========================================
    // A. Due-offer recovery sweep
    // ==========================================
    try {
      let dueSweep = checkpoint.dueOfferSweep;
      let dueEpoch = dueSweep.sweepEpoch;
      let dueUB = dueSweep.upperBound;

      if (dueEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('SWEEP_EPOCH_OVERFLOW');
      }

      // 1. High-water acquisition if upperBound is currently null
      if (dueUB.offerExpiresAt === null) {
        const hwSnap = await db.collection('jobs')
          .where('status', '==', 'offered')
          .where('offerExpiresAt', '<=', nowTimestamp)
          .orderBy('offerExpiresAt', 'desc')
          .orderBy(FieldPath.documentId(), 'desc')
          .endAt(minTimestamp)
          .limit(1)
          .get();

        let candidateUB = null;
        if (!hwSnap.empty) {
          const doc = hwSnap.docs[0];
          const d = doc.data();
          if (isAuthoritativeTimestamp(d.offerExpiresAt, TimestampClass) && isLegalDocumentId(doc.id)) {
            candidateUB = {
              offerExpiresAt: d.offerExpiresAt,
              jobId: doc.id,
            };
          }
        }

        if (candidateUB) {
          validateTuple(candidateUB, 'offerExpiresAt', 'jobId', 'due candidateUB', TimestampClass);
          dueSweep = await db.runTransaction(async tx => {
            const snap = await tx.get(checkpointRef);
            const cur = snap.data();
            validateRecoveryCheckpoint(cur, TimestampClass);
            const curDue = cur.dueOfferSweep;
            if (curDue.sweepEpoch !== dueEpoch || curDue.upperBound.offerExpiresAt !== null) {
              return curDue;
            }
            tx.update(checkpointRef, {
              'dueOfferSweep.upperBound': candidateUB,
              updatedAt: TimestampClass.fromMillis(now().getTime()),
            });
            return { ...curDue, upperBound: candidateUB };
          });
          dueEpoch = dueSweep.sweepEpoch;
          dueUB = dueSweep.upperBound;
        }
      }

      // 2. Forward bounded scan (only if an upper bound exists for this epoch)
      if (dueUB.offerExpiresAt !== null) {
        let dueScanned = 0;
        let lastScannedTuple = dueSweep.cursor;
        let sweepCompleted = false;

        while (dueScanned < maxDueScannedPerInvocation && !sweepCompleted) {
          const pageSize = Math.min(dueBatchSize, maxDueScannedPerInvocation - dueScanned);
          if (pageSize <= 0) break;

          let dueQuery = db.collection('jobs')
            .where('status', '==', 'offered')
            .where('offerExpiresAt', '<=', nowTimestamp)
            .orderBy('offerExpiresAt', 'asc')
            .orderBy(FieldPath.documentId(), 'asc');

          if (lastScannedTuple.offerExpiresAt !== null && lastScannedTuple.jobId !== null) {
            dueQuery = dueQuery.startAfter(lastScannedTuple.offerExpiresAt, lastScannedTuple.jobId);
          } else {
            dueQuery = dueQuery.startAt(minTimestamp);
          }
          dueQuery = dueQuery.endAt(dueUB.offerExpiresAt, dueUB.jobId);
          dueQuery = dueQuery.limit(pageSize);

          const duePage = await dueQuery.get();
          if (duePage.empty) {
            sweepCompleted = true;
            break;
          }

          for (const doc of duePage.docs) {
            counts.dueScanned++;
            dueScanned++;

            const job = doc.data();
            const isDocValid = isAuthoritativeTimestamp(job.offerExpiresAt, TimestampClass) && isLegalDocumentId(doc.id);
            if (!isDocValid) {
              continue;
            }
            counts.discoveredDue++;

            const docTuple = {
              offerExpiresAt: job.offerExpiresAt,
              jobId: doc.id,
            };

            const cmpUB = compareTuples(docTuple, dueUB, 'offerExpiresAt', 'jobId');
            if (cmpUB > 0) {
              sweepCompleted = true;
              break;
            }

            if (job.currentOfferId && positive(job.dispatchGeneration)) {
              try {
                const res = await timeoutMgr.expireOfferTimeout({
                  jobId: doc.id,
                  offerId: job.currentOfferId,
                  dispatchGeneration: job.dispatchGeneration,
                  triggerCascade: true,
                });
                if (res.expired) counts.expired++;
              } catch {
                counts.failed++;
              }
            }

            lastScannedTuple = docTuple;

            if (cmpUB === 0) {
              sweepCompleted = true;
              break;
            }

            if (dueScanned >= maxDueScannedPerInvocation) {
              break;
            }
          }
        }

        // 3. Commit checkpoint advancement or sweep completion
        await db.runTransaction(async tx => {
          const snap = await tx.get(checkpointRef);
          const cur = snap.data();
          validateRecoveryCheckpoint(cur, TimestampClass);
          const curDue = cur.dueOfferSweep;

          // Epoch + Upper-Bound Fencing
          if (curDue.sweepEpoch !== dueEpoch ||
              compareTuples(curDue.upperBound, dueUB, 'offerExpiresAt', 'jobId') !== 0) {
            return { updated: false, reason: 'FENCED_STALE' };
          }

          if (sweepCompleted) {
            if (curDue.sweepEpoch >= Number.MAX_SAFE_INTEGER) {
              throw new DispatchError('SWEEP_EPOCH_OVERFLOW');
            }
            tx.update(checkpointRef, {
              'dueOfferSweep.sweepEpoch': curDue.sweepEpoch + 1,
              'dueOfferSweep.cursor': { offerExpiresAt: null, jobId: null },
              'dueOfferSweep.upperBound': { offerExpiresAt: null, jobId: null },
              updatedAt: TimestampClass.fromMillis(now().getTime()),
            });
          } else if (lastScannedTuple && lastScannedTuple.offerExpiresAt !== null) {
            if (compareTuples(lastScannedTuple, curDue.cursor, 'offerExpiresAt', 'jobId') > 0) {
              tx.update(checkpointRef, {
                'dueOfferSweep.cursor': lastScannedTuple,
                updatedAt: TimestampClass.fromMillis(now().getTime()),
              });
            }
          }
        });
      }
    } catch (err) {
      if (err.code === 'SWEEP_EPOCH_OVERFLOW' || err.code === 'CHECKPOINT_INVALID') throw err;
      counts.failed++;
    }

    // ==========================================
    // B. Pending-enqueue recovery sweep
    // ==========================================
    try {
      const freshSnap = await checkpointRef.get();
      const freshData = freshSnap.data();
      validateRecoveryCheckpoint(freshData);

      let pendingSweep = freshData.pendingEnqueueSweep;
      let pendingEpoch = pendingSweep.sweepEpoch;
      let pendingUB = pendingSweep.upperBound;

      if (pendingEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new DispatchError('SWEEP_EPOCH_OVERFLOW');
      }

      // 1. High-water acquisition if upperBound is currently null
      if (pendingUB.expiresAt === null) {
        const hwSnap = await db.collection('job_offers')
          .where('status', '==', 'offered')
          .orderBy('expiresAt', 'desc')
          .orderBy(FieldPath.documentId(), 'desc')
          .startAt(maxTimestamp)
          .endAt(minTimestamp)
          .limit(1)
          .get();

        let candidateUB = null;
        if (!hwSnap.empty) {
          const doc = hwSnap.docs[0];
          const d = doc.data();
          if (isAuthoritativeTimestamp(d.expiresAt, TimestampClass) && isLegalDocumentId(doc.id)) {
            candidateUB = {
              expiresAt: d.expiresAt,
              offerId: doc.id,
            };
          }
        }

        if (candidateUB) {
          validateTuple(candidateUB, 'expiresAt', 'offerId', 'pending candidateUB', TimestampClass);
          pendingSweep = await db.runTransaction(async tx => {
            const snap = await tx.get(checkpointRef);
            const cur = snap.data();
            validateRecoveryCheckpoint(cur, TimestampClass);
            const curPending = cur.pendingEnqueueSweep;
            if (curPending.sweepEpoch !== pendingEpoch || curPending.upperBound.expiresAt !== null) {
              return curPending;
            }
            tx.update(checkpointRef, {
              'pendingEnqueueSweep.upperBound': candidateUB,
              updatedAt: TimestampClass.fromMillis(now().getTime()),
            });
            return { ...curPending, upperBound: candidateUB };
          });
          pendingEpoch = pendingSweep.sweepEpoch;
          pendingUB = pendingSweep.upperBound;
        }
      }

      // 2. Forward bounded scan (bounds TOTAL SCANNED DOCUMENTS)
      if (pendingUB.expiresAt !== null) {
        let pendingScanned = 0;
        let lastScannedTuple = pendingSweep.cursor;
        let sweepCompleted = false;

        while (pendingScanned < maxPendingScannedPerInvocation && !sweepCompleted) {
          const pageSize = Math.min(enqueueBatchSize, maxPendingScannedPerInvocation - pendingScanned);
          if (pageSize <= 0) break;

          let pendingQuery = db.collection('job_offers')
            .where('status', '==', 'offered')
            .orderBy('expiresAt', 'asc')
            .orderBy(FieldPath.documentId(), 'asc');

          if (lastScannedTuple.expiresAt !== null && lastScannedTuple.offerId !== null) {
            pendingQuery = pendingQuery.startAfter(lastScannedTuple.expiresAt, lastScannedTuple.offerId);
          } else {
            pendingQuery = pendingQuery.startAt(minTimestamp);
          }
          pendingQuery = pendingQuery.endAt(pendingUB.expiresAt, pendingUB.offerId);
          pendingQuery = pendingQuery.limit(pageSize);

          const pendingPage = await pendingQuery.get();
          if (pendingPage.empty) {
            sweepCompleted = true;
            break;
          }

          for (const offerDoc of pendingPage.docs) {
            counts.pendingScanned++;
            pendingScanned++;

            const offer = offerDoc.data();
            const isDocValid = isAuthoritativeTimestamp(offer.expiresAt, TimestampClass) && isLegalDocumentId(offerDoc.id);
            if (!isDocValid) {
              continue;
            }

            const docTuple = {
              expiresAt: offer.expiresAt,
              offerId: offerDoc.id,
            };

            const cmpUB = compareTuples(docTuple, pendingUB, 'expiresAt', 'offerId');
            if (cmpUB > 0) {
              sweepCompleted = true;
              break;
            }

            if (offer.timeoutTaskState === 'pending') {
              counts.discoveredPending++;
              const expiresMs = offer.expiresAt.toMillis();
              if (nowMs >= expiresMs) {
                try {
                  const res = await timeoutMgr.expireOfferTimeout({
                    jobId: offer.jobId,
                    offerId: offerDoc.id,
                    dispatchGeneration: offer.dispatchGeneration,
                    triggerCascade: true,
                  });
                  if (res.expired) counts.expired++;
                } catch {
                  counts.failed++;
                }
              } else {
                try {
                  const scheduleDate = offer.expiresAt.toDate();
                  const enq = await taskQueue.enqueueOfferTimeoutTask({
                    jobId: offer.jobId,
                    offerId: offerDoc.id,
                    dispatchGeneration: offer.dispatchGeneration,
                    scheduleTime: scheduleDate,
                  });
                  if (enq.enqueued) {
                    await timeoutMgr.convergeTaskMarker({
                      jobId: offer.jobId,
                      offerId: offerDoc.id,
                      dispatchGeneration: offer.dispatchGeneration,
                      taskId: enq.taskId,
                    });
                    counts.markerConverged++;
                  }
                } catch {
                  counts.failed++;
                }
              }
            }

            lastScannedTuple = docTuple;

            if (cmpUB === 0) {
              sweepCompleted = true;
              break;
            }

            if (pendingScanned >= maxPendingScannedPerInvocation) {
              break;
            }
          }
        }

        // 3. Commit checkpoint advancement or sweep completion
        await db.runTransaction(async tx => {
          const snap = await tx.get(checkpointRef);
          const cur = snap.data();
          validateRecoveryCheckpoint(cur, TimestampClass);
          const curPending = cur.pendingEnqueueSweep;

          // Epoch + Upper-Bound Fencing
          if (curPending.sweepEpoch !== pendingEpoch ||
              compareTuples(curPending.upperBound, pendingUB, 'expiresAt', 'offerId') !== 0) {
            return { updated: false, reason: 'FENCED_STALE' };
          }

          if (sweepCompleted) {
            if (curPending.sweepEpoch >= Number.MAX_SAFE_INTEGER) {
              throw new DispatchError('SWEEP_EPOCH_OVERFLOW');
            }
            tx.update(checkpointRef, {
              'pendingEnqueueSweep.sweepEpoch': curPending.sweepEpoch + 1,
              'pendingEnqueueSweep.cursor': { expiresAt: null, offerId: null },
              'pendingEnqueueSweep.upperBound': { expiresAt: null, offerId: null },
              updatedAt: TimestampClass.fromMillis(now().getTime()),
            });
          } else if (lastScannedTuple && lastScannedTuple.expiresAt !== null) {
            if (compareTuples(lastScannedTuple, curPending.cursor, 'expiresAt', 'offerId') > 0) {
              tx.update(checkpointRef, {
                'pendingEnqueueSweep.cursor': lastScannedTuple,
                updatedAt: TimestampClass.fromMillis(now().getTime()),
              });
            }
          }
        });
      }
    } catch (err) {
      if (err.code === 'SWEEP_EPOCH_OVERFLOW' || err.code === 'CHECKPOINT_INVALID') throw err;
      counts.failed++;
    }

    if (counts.failed) throw new DispatchError('RECOVERY_INCOMPLETE', { retryable: true });
    return counts;
  }

  return { consumePendingJob, reconcilePendingJobs, reconcileOfferTimeouts };
}

function isLegalDocumentId(id) {
  return typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= 1500 &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    !/^__.*__$/.test(id) &&
    /^[A-Za-z0-9_-]+$/.test(id);
}

function isAuthoritativeTimestamp(val, TimestampClass = Timestamp) {
  if (!val || typeof val !== 'object') return false;
  if (val instanceof Date) return false;
  if (TimestampClass && val instanceof TimestampClass) return true;
  return Number.isInteger(val.seconds) &&
    Number.isInteger(val.nanoseconds) &&
    val.nanoseconds >= 0 &&
    val.nanoseconds < 1e9 &&
    typeof val.toMillis === 'function' &&
    typeof val.toDate === 'function';
}

function compareTimestamp(a, b) {
  if (a.seconds !== b.seconds) {
    return a.seconds < b.seconds ? -1 : 1;
  }
  if (a.nanoseconds !== b.nanoseconds) {
    return a.nanoseconds < b.nanoseconds ? -1 : 1;
  }
  return 0;
}

function compareDocumentId(id1, id2) {
  if (id1 === id2) return 0;
  return id1 < id2 ? -1 : 1;
}

function compareTuples(t1, t2, timestampKey, idKey) {
  const t1Null = !t1 || t1[timestampKey] === null;
  const t2Null = !t2 || t2[timestampKey] === null;
  if (t1Null && t2Null) return 0;
  if (t1Null) return -1;
  if (t2Null) return 1;

  const ts1 = t1[timestampKey];
  const ts2 = t2[timestampKey];
  if (!isAuthoritativeTimestamp(ts1) || !isAuthoritativeTimestamp(ts2)) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }

  const cmpTs = compareTimestamp(ts1, ts2);
  if (cmpTs !== 0) return cmpTs;

  const id1 = t1[idKey] || '';
  const id2 = t2[idKey] || '';
  return compareDocumentId(id1, id2);
}

function validateRecoveryCheckpoint(data, TimestampClass = Timestamp) {
  if (!data || typeof data !== 'object') throw new DispatchError('CHECKPOINT_INVALID');
  if (data.version !== 1) throw new DispatchError('CHECKPOINT_INVALID');
  if (!exactKeys(data, ['version', 'dueOfferSweep', 'pendingEnqueueSweep', 'updatedAt'])) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }

  validateSweepState(data.dueOfferSweep, 'offerExpiresAt', 'jobId', TimestampClass);
  validateSweepState(data.pendingEnqueueSweep, 'expiresAt', 'offerId', TimestampClass);
  if (!isAuthoritativeTimestamp(data.updatedAt, TimestampClass)) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }
}

function validateSweepState(sweep, timestampKey, idKey, TimestampClass = Timestamp) {
  if (!sweep || typeof sweep !== 'object') throw new DispatchError('CHECKPOINT_INVALID');
  if (!exactKeys(sweep, ['sweepEpoch', 'cursor', 'upperBound'])) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }
  if (!Number.isSafeInteger(sweep.sweepEpoch) || sweep.sweepEpoch < 1 || sweep.sweepEpoch > Number.MAX_SAFE_INTEGER) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }
  validateTuple(sweep.cursor, timestampKey, idKey, 'cursor', TimestampClass);
  validateTuple(sweep.upperBound, timestampKey, idKey, 'upperBound', TimestampClass);
}

function validateTuple(tuple, timestampKey, idKey, label, TimestampClass = Timestamp) {
  if (!tuple || typeof tuple !== 'object') throw new DispatchError('CHECKPOINT_INVALID');
  if (!exactKeys(tuple, [timestampKey, idKey])) {
    throw new DispatchError('CHECKPOINT_INVALID');
  }
  const ts = tuple[timestampKey];
  const id = tuple[idKey];
  if (ts === null && id === null) return;
  if (ts === null || id === null) throw new DispatchError('CHECKPOINT_INVALID');
  if (!isAuthoritativeTimestamp(ts, TimestampClass)) throw new DispatchError('CHECKPOINT_INVALID');
  if (!isLegalDocumentId(id)) throw new DispatchError('CHECKPOINT_INVALID');
}

async function getOrBootstrapCheckpoint(db, checkpointRef, TimestampClass = Timestamp, nowMs = Date.now()) {
  return await db.runTransaction(async tx => {
    const snap = await tx.get(checkpointRef);
    if (!snap.exists) {
      const initial = {
        version: 1,
        dueOfferSweep: {
          sweepEpoch: 1,
          cursor: { offerExpiresAt: null, jobId: null },
          upperBound: { offerExpiresAt: null, jobId: null },
        },
        pendingEnqueueSweep: {
          sweepEpoch: 1,
          cursor: { expiresAt: null, offerId: null },
          upperBound: { expiresAt: null, offerId: null },
        },
        updatedAt: TimestampClass.fromMillis(nowMs),
      };
      tx.set(checkpointRef, initial);
      return initial;
    }
    const data = snap.data();
    validateRecoveryCheckpoint(data, TimestampClass);
    return data;
  });
}

function productionRecovery(env = process.env) {
  const integer = (key, allowZero = false) => {
    if (!/^\d+$/.test(env[key] || '')) throw new DispatchError('RUNTIME_CONFIG_INVALID');
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new DispatchError('RUNTIME_CONFIG_INVALID');
    return value;
  };
  const db = getFirestore();
  const service = createDispatchService({ db,
    defaultLeaseDurationMs: integer('DISPATCH_LEASE_MS'), retryDelayMs: integer('DISPATCH_RETRY_DELAY_MS'),
    olaClient: createOlaMapsClient({ timeoutMs: integer('OLA_MATRIX_TIMEOUT_MS'),
      maxRetries: integer('OLA_MATRIX_MAX_RETRIES', true), backoffMs: integer('OLA_MATRIX_BACKOFF_MS', true) }),
  });
  return createDispatchRecovery({ db, service, batchSize: integer('DISPATCH_RECONCILE_BATCH_SIZE') });
}

module.exports = {
  createDispatchRecovery,
  productionRecovery,
  compareTimestamp,
  compareDocumentId,
  isLegalDocumentId,
  isAuthoritativeTimestamp,
  compareTuples,
  validateRecoveryCheckpoint,
  getOrBootstrapCheckpoint,
};
