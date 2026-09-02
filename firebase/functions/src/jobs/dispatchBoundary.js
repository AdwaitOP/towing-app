'use strict';

const { bootstrapDispatchJob } = require('../dispatch/dispatchService');

// Phase 3 has already committed payment/pending_offer. This optional handoff
// only materializes workflow fields; the Firestore consumer runs matching.
// Even a missed/failed handoff is recovered by the scheduled status-only scan.
function createDispatchBoundary({ handoff = bootstrapDispatchJob } = {}) {
  return {
    async triggerDispatch(jobId) {
      try {
        const result = await handoff(jobId);
        return { dispatched: false, deferred: true, reason: result.reason || 'DURABLE_HANDOFF' };
      } catch {
        return { dispatched: false, deferred: true, reason: 'RECOVERY_REQUIRED' };
      }
    },
  };
}

module.exports = { createDispatchBoundary, triggerDispatch: createDispatchBoundary().triggerDispatch };
