/**
 * Phase 4 Dispatch Boundary Stub
 *
 * Phase 4 will transactionally claim dispatch by jobId.
 * Phase 3 calls this after a successful payment webhook or resume.
 */
async function triggerDispatch(jobId) {
  if (typeof jobId !== 'string' || !jobId) throw new TypeError('jobId is required');
  console.log(`[Phase 4 boundary] job ${jobId} is durably pending_offer; Phase 4 is not implemented`);
  // In Phase 4, this will:
  // 1. Transactionally verify job status is pending_offer.
  // 2. Fetch driver shortlist (Haversine + Ola Maps Matrix).
  // 3. Update status to 'offered' and set 'offeredTo'.
  // 4. Enqueue 45s Cloud Task timeout.
  return { dispatched: false, phase4Implemented: false };
}

module.exports = {
  triggerDispatch
};
