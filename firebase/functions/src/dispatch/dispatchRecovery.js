'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { createDispatchService } = require('./dispatchService');
const { DispatchError, positive } = require('./dispatchValidation');
const { createOlaMapsClient } = require('../services/olaMapsClient');

function createDispatchRecovery({ db = getFirestore(), service = createDispatchService({ db }), batchSize = 50 } = {}) {
  if (!positive(batchSize)) throw new DispatchError('RUNTIME_CONFIG_INVALID');
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
  return { consumePendingJob, reconcilePendingJobs };
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

module.exports = { createDispatchRecovery, productionRecovery };
