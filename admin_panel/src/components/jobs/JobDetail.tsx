/**
 * TowMitra Phase 6 M2 — Live Job Detail Component (M2-ARCH-1, Section 5)
 *
 * Implements:
 * - Read-only job attributes, lifecycle timestamps, and protected contact
 * - Distinct, verified financial labels (Booking Fee, Platform Commission, Estimated Driver Fare)
 * - Current dispatch run progress (candidates, ETA, ranking mode, round)
 * - Safe countdown display (never triggers backend state transition)
 * - On-demand linked driver identity summary with timestamp
 * - Canonical operational hold, retry wait, dispatchLastFailure, and customer cancellation diagnostics
 * - Safe coordinate parsing guarding against malformed optional numeric values
 * - Strictly NO dispatch/financial mutation controls
 */

import React, { useState, useEffect } from 'react';
import type {
  JobRecord,
  DispatchRunRecord,
  DispatchCandidate,
  DriverIdentitySummary,
} from '@/types/operations';
import { formatPaiseToRupees } from '@/services/liveJobs';
import {
  FileText,
  MapPin,
  Clock,
  Phone,
  Truck,
  IndianRupee,
  AlertTriangle,
  RotateCcw,
  User,
  ShieldAlert,
} from 'lucide-react';

interface JobDetailProps {
  job: JobRecord | null;
  loading: boolean;
  isFromCache: boolean;
  dispatchRun: DispatchRunRecord | null;
  runLoading: boolean;
  driverIdentities: Map<string, DriverIdentitySummary>;
  identityLoading: boolean;
  onLoadDriverIdentity: (uid: string) => Promise<void>;
}

function formatCoords(coords?: { latitude?: unknown; longitude?: unknown } | null): string {
  if (
    coords &&
    typeof coords.latitude === 'number' &&
    Number.isFinite(coords.latitude) &&
    typeof coords.longitude === 'number' &&
    Number.isFinite(coords.longitude)
  ) {
    return `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`;
  }
  return 'Unavailable';
}


export const JobDetail: React.FC<JobDetailProps> = ({
  job,
  loading,
  isFromCache,
  dispatchRun,
  runLoading,
  driverIdentities,
  identityLoading,
  onLoadDriverIdentity,
}) => {
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  const currentJobId = job?.id ?? null;
  const [attemptState, setAttemptState] = useState<{ jobId: string | null; uids: Set<string> }>(() => ({
    jobId: currentJobId,
    uids: new Set(),
  }));

  if (attemptState.jobId !== currentJobId) {
    setAttemptState({
      jobId: currentJobId,
      uids: new Set(),
    });
  }

  const attemptedIdentityUids = attemptState.jobId === currentJobId ? attemptState.uids : new Set<string>();

  // Local offer countdown timer (visual only, never writes state)
  useEffect(() => {
    if (!job?.offerExpiresAt) {
      return;
    }

    const interval = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [job?.offerExpiresAt]);

  const secondsRemaining = job?.offerExpiresAt
    ? Math.max(0, job.offerExpiresAt.seconds - nowSec)
    : null;

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-500 bg-white rounded-xl border border-slate-200">
        <RotateCcw className="w-8 h-8 animate-spin mx-auto text-indigo-600 mb-2" />
        <p className="text-sm font-medium">Loading job details...</p>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="p-8 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
        <FileText className="w-10 h-10 mx-auto text-slate-300 mb-2" />
        <p className="text-sm font-medium text-slate-600">Select a job from the dashboard</p>
        <p className="text-xs text-slate-400 mt-1">Click any operational row to inspect real-time dispatch progress.</p>
      </div>
    );
  }

  const formatTimestamp = (ts?: { toDate?: () => Date; seconds: number }) => {
    if (!ts) return 'Unavailable';
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts.seconds * 1000);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  };

  const isHold = job.dispatchState === 'operational_hold' || Boolean(job.operational_hold);
  const isRetryWait = job.dispatchState === 'retry_wait' || (Boolean(job.dispatchNextActionAt) && !isHold);
  const isCustomerCancellation =
    (job.cancellationResolutionState === 'pending' && job.cancellationReason === 'customer_requested') ||
    Boolean(job.customerCancellationPending) ||
    job.cancellationResolutionState === 'pending';

  const currentOfferedDriver = job.offeredTo ? driverIdentities.get(job.offeredTo) : null;
  const currentAssignedDriver = job.assignedDriver ? driverIdentities.get(job.assignedDriver) : null;

  const isOfferedAttempted = Boolean(
    currentOfferedDriver || (job.offeredTo && attemptedIdentityUids.has(job.offeredTo))
  );
  const isAssignedAttempted = Boolean(
    currentAssignedDriver || (job.assignedDriver && attemptedIdentityUids.has(job.assignedDriver))
  );

  const handleLoadOfferedIdentity = (uid: string) => {
    setAttemptState((prev) => ({
      jobId: currentJobId,
      uids: new Set(prev.jobId === currentJobId ? prev.uids : []).add(uid),
    }));
    onLoadDriverIdentity(uid);
  };

  const handleLoadAssignedIdentity = (uid: string) => {
    setAttemptState((prev) => ({
      jobId: currentJobId,
      uids: new Set(prev.jobId === currentJobId ? prev.uids : []).add(uid),
    }));
    onLoadDriverIdentity(uid);
  };

  return (
    <div className="space-y-6">
      {/* Cache / Offline Notice */}
      {isFromCache && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>Job details loaded from local cache. Awaiting fresh server update.</span>
        </div>
      )}

      {/* Operational Diagnostic Banners */}
      {isHold && (
        <div className="p-3.5 bg-amber-100 border border-amber-300 rounded-xl text-amber-900 text-xs space-y-1">
          <div className="flex items-center gap-2 font-bold text-amber-950">
            <ShieldAlert className="w-4 h-4 text-amber-700" />
            <span>Operational Hold Active</span>
          </div>
          <p>
            Dispatch is paused for this job due to an automated safety fence or routing failure.
            {job.dispatchLastFailure && (
              <span>
                {' '}Reason: <span className="font-mono font-bold">{job.dispatchLastFailure.code}</span> ({job.dispatchLastFailure.source})
                {job.dispatchLastFailure.retryable !== undefined && ` • ${job.dispatchLastFailure.retryable ? 'Retryable' : 'Non-retryable'}`}
                {job.dispatchLastFailure.occurredAt && ` • Occurred: ${formatTimestamp(job.dispatchLastFailure.occurredAt)}`}
              </span>
            )}
          </p>
          {job.dispatchNextActionAt && (
            <p className="text-[11px] text-amber-800">
              Next Evaluation (<span className="font-mono font-semibold">dispatchNextActionAt</span>): {formatTimestamp(job.dispatchNextActionAt)}
            </p>
          )}
        </div>
      )}

      {isRetryWait && !isHold && (
        <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-blue-900 text-xs space-y-1">
          <div className="flex items-center gap-2 font-bold text-blue-950">
            <Clock className="w-4 h-4 text-blue-700" />
            <span>Dispatch Retry Pending</span>
          </div>
          <p>
            Next automated action scheduled: <span className="font-mono font-semibold">dispatchNextActionAt</span>: {formatTimestamp(job.dispatchNextActionAt)}
          </p>
          {job.dispatchLastFailure && (
            <p className="text-[11px] text-blue-800">
              Last Failure: <span className="font-mono font-bold">{job.dispatchLastFailure.code}</span> ({job.dispatchLastFailure.source})
              {job.dispatchLastFailure.retryable !== undefined && ` • ${job.dispatchLastFailure.retryable ? 'Retryable' : 'Non-retryable'}`}
              {job.dispatchLastFailure.occurredAt && ` • Occurred: ${formatTimestamp(job.dispatchLastFailure.occurredAt)}`}
            </p>
          )}
        </div>
      )}

      {isCustomerCancellation && (
        <div className="p-3.5 bg-blue-100 border border-blue-300 rounded-xl text-blue-900 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-blue-700 flex-shrink-0" />
          <span>Customer cancellation requested. Awaiting backend dispatch resolution.</span>
        </div>
      )}

      {/* Job Header & Core Attributes */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 font-mono">{job.id}</h2>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase ${
                  job.status === 'in_progress'
                    ? 'bg-blue-100 text-blue-800'
                    : job.status === 'accepted'
                    ? 'bg-emerald-100 text-emerald-800'
                    : job.status === 'offered'
                    ? 'bg-purple-100 text-purple-800'
                    : job.status === 'awaiting_payment'
                    ? 'bg-slate-100 text-slate-700'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {job.status}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Category: <span className="font-semibold text-slate-700 capitalize">{job.towingCategory}</span>
              {job.dispatchGeneration !== undefined && ` • Generation: ${job.dispatchGeneration}`}
              {job.dispatchState && ` • State: ${job.dispatchState}`}
            </p>
          </div>

          <div className="text-right">
            <span className="text-[11px] text-slate-400 block">Created</span>
            <span className="text-xs text-slate-700 font-medium">{formatTimestamp(job.createdAt)}</span>
          </div>
        </div>

        {/* Financial Amounts (Distinct labels & integer paise conversion) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
          <div className="space-y-0.5">
            <span className="text-slate-500 flex items-center gap-1 font-medium">
              <IndianRupee className="w-3.5 h-3.5 text-indigo-600" /> Platform Booking Fee
            </span>
            <span className="font-bold text-slate-900 text-sm">
              {formatPaiseToRupees(job.bookingFeePaise)}
            </span>
          </div>

          <div className="space-y-0.5">
            <span className="text-slate-500 flex items-center gap-1 font-medium">
              <IndianRupee className="w-3.5 h-3.5 text-indigo-600" /> Platform Commission
            </span>
            <span className="font-bold text-slate-900 text-sm">
              {formatPaiseToRupees(job.driverCommissionPaise)}
            </span>
          </div>

          <div className="space-y-0.5">
            <span className="text-slate-500 flex items-center gap-1 font-medium">
              <IndianRupee className="w-3.5 h-3.5 text-slate-400" /> Estimated Driver Fare
            </span>
            <span className="font-bold text-slate-700 text-sm">
              {formatPaiseToRupees(job.estimatedFarePaise)}
            </span>
            <span className="text-[10px] text-slate-400 block">Informational driver fare</span>
          </div>
        </div>

        {/* Location & Protected Contact */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs pt-1">
          <div className="space-y-1">
            <span className="text-slate-400 font-medium flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-emerald-600" /> Pickup Coordinates
            </span>
            <span className="font-mono text-slate-800 text-xs">
              {formatCoords(job.pickupCoords)}
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-slate-400 font-medium flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-red-600" /> Destination Coordinates
            </span>
            <span className="font-mono text-slate-800 text-xs">
              {formatCoords(job.destCoords)}
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-slate-400 font-medium flex items-center gap-1">
              <Phone className="w-3.5 h-3.5 text-slate-500" /> Customer Phone (Protected Detail)
            </span>
            <span className="font-mono text-slate-900 font-semibold">
              {job.customerPhone || 'Unavailable'}
            </span>
          </div>

          <div className="space-y-1">
            <span className="text-slate-400 font-medium flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-slate-500" /> Last Backend Update
            </span>
            <span className="text-slate-700 font-medium">{formatTimestamp(job.updatedAt)}</span>
          </div>
        </div>
      </div>

      {/* Dispatch Assignment & Driver Status */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Truck className="w-4 h-4 text-indigo-600" />
          Driver Assignment & Current Offer
        </h3>

        {/* Active Offer Details */}
        {job.status === 'offered' && (
          <div className="p-3.5 bg-purple-50/70 border border-purple-200 rounded-lg space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-purple-900">Current Offer in Flight</span>
              <span className="font-mono text-purple-700 font-semibold">
                {secondsRemaining !== null && secondsRemaining > 0
                  ? `Offer expires in ${secondsRemaining}s`
                  : 'Deadline passed; awaiting backend resolution'}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-purple-100">
              <span className="text-purple-800 font-mono">Offered Driver UID: {job.offeredTo || 'None'}</span>
              {job.offeredTo && (
                <button
                  type="button"
                  onClick={() => handleLoadOfferedIdentity(job.offeredTo!)}
                  disabled={identityLoading}
                  className="px-2.5 py-1 bg-white border border-purple-300 rounded text-purple-800 font-semibold text-[11px] hover:bg-purple-100 flex items-center gap-1"
                >
                  <User className="w-3 h-3" />
                  {isOfferedAttempted ? 'Refresh Identity' : 'Load Driver Identity'}
                </button>
              )}
            </div>
            {currentOfferedDriver ? (
              <div className="p-2.5 bg-white border border-purple-200 rounded text-[11px] text-slate-700 space-y-1">
                <div className="font-semibold text-slate-900">{currentOfferedDriver.name} ({currentOfferedDriver.phone})</div>
                <div className="text-slate-500 font-mono">Vehicle: {currentOfferedDriver.vehicleNumber} • Truck: {currentOfferedDriver.truckType}</div>
                <div className="text-[10px] text-slate-400">Identity last fetched: {currentOfferedDriver.lastFetchedAt.toLocaleTimeString()}</div>
              </div>
            ) : isOfferedAttempted && !identityLoading ? (
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-500 italic">
                Driver profile unavailable or removed from server.
              </div>
            ) : null}
          </div>
        )}

        {/* Accepted / In-Progress Driver Details */}
        {(job.status === 'accepted' || job.status === 'in_progress') && (
          <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-emerald-900">Assigned Driver</span>
              <span className="px-2 py-0.5 bg-emerald-200 text-emerald-900 rounded font-semibold text-[10px] uppercase">
                {job.status}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-emerald-100">
              <span className="text-emerald-800 font-mono">Driver UID: {job.assignedDriver || 'None'}</span>
              {job.assignedDriver && (
                <button
                  type="button"
                  onClick={() => handleLoadAssignedIdentity(job.assignedDriver!)}
                  disabled={identityLoading}
                  className="px-2.5 py-1 bg-white border border-emerald-300 rounded text-emerald-800 font-semibold text-[11px] hover:bg-emerald-100 flex items-center gap-1"
                >
                  <User className="w-3 h-3" />
                  {isAssignedAttempted ? 'Refresh Identity' : 'Load Driver Identity'}
                </button>
              )}
            </div>
            {currentAssignedDriver ? (
              <div className="p-2.5 bg-white border border-emerald-200 rounded text-[11px] text-slate-700 space-y-1">
                <div className="font-semibold text-slate-900">{currentAssignedDriver.name} ({currentAssignedDriver.phone})</div>
                <div className="text-slate-500 font-mono">Vehicle: {currentAssignedDriver.vehicleNumber} • Truck: {currentAssignedDriver.truckType}</div>
                <div className="text-[10px] text-slate-400">Identity last fetched: {currentAssignedDriver.lastFetchedAt.toLocaleTimeString()}</div>
              </div>
            ) : isAssignedAttempted && !identityLoading ? (
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-500 italic">
                Driver profile unavailable or removed from server.
              </div>
            ) : null}
          </div>
        )}

        {/* No Driver Assigned */}
        {job.status === 'pending_offer' && (
          <p className="text-xs text-slate-500 italic">
            Job is in pending_offer state. The backend dispatch engine is searching and evaluating candidates.
          </p>
        )}
      </div>

      {/* Linked Dispatch Run Progress */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Clock className="w-4 h-4 text-indigo-600" />
            Current Dispatch Run Evidence
          </h3>
          {runLoading && <RotateCcw className="w-3.5 h-3.5 animate-spin text-slate-400" />}
        </div>

        {dispatchRun ? (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-slate-50 rounded-lg">
              <div>
                <span className="text-slate-400 block text-[11px]">Run Status</span>
                <span className="font-semibold text-slate-800 capitalize">{dispatchRun.status}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">Ranking Mode</span>
                <span className="font-semibold text-slate-800 font-mono">{dispatchRun.rankingMode || 'Default'}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">Candidate Index</span>
                <span className="font-semibold text-slate-800 font-mono">{dispatchRun.nextCandidateIndex ?? 'N/A'}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[11px]">Total Candidates</span>
                <span className="font-semibold text-slate-800 font-mono">{dispatchRun.candidateCount ?? (dispatchRun.candidates?.length || 0)}</span>
              </div>
            </div>

            {/* Candidates List */}
            {dispatchRun.candidates && dispatchRun.candidates.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-slate-700 block">Run Candidates (Capped at 30)</span>
                <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                  {dispatchRun.candidates.map((cand: DispatchCandidate & { driverId?: string }, idx) => {
                    const cUid = cand.driverUid || cand.driverId || 'Unknown';
                    return (
                      <div key={cUid + idx} className="p-2.5 flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-slate-400 font-mono w-4">#{idx + 1}</span>
                          <span className="font-mono text-slate-800">{cUid}</span>
                          {cand.round !== undefined && (
                            <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-mono">
                              Round {cand.round}
                            </span>
                          )}
                          <span className="text-slate-500">
                            {cand.etaSeconds !== undefined ? `ETA: ${Math.round(cand.etaSeconds / 60)} min` : ''}
                            {cand.distanceMeters !== undefined ? ` (${(cand.distanceMeters / 1000).toFixed(1)} km)` : ''}
                          </span>
                          {cand.reason && (
                            <span className="text-slate-400 italic text-[10px]">
                              ({cand.reason})
                            </span>
                          )}
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase flex-shrink-0 ${
                            cand.status === 'offered'
                              ? 'bg-purple-100 text-purple-800'
                              : cand.status === 'accepted'
                              ? 'bg-emerald-100 text-emerald-800'
                              : cand.status === 'declined'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {cand.status || 'eligible'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-400 italic">
            No active dispatch run linked to this job.
          </p>
        )}
      </div>
    </div>
  );
};
