/**
 * TowMitra Phase 6 M2 — Live Jobs Dashboard Page (M2-ARCH-1, Section 5)
 *
 * Implements:
 * - Default active filter (pending_offer, offered, accepted, in_progress)
 * - Separate mandatory awaiting_payment filter
 * - Excludes terminal states from list queries
 * - Bounded pagination: 25 rows per page, live first page, bounded snapshot older pages
 * - Two-column responsive layout with JobDetail & candidate dispatch evidence
 * - Masked customer phone in row summary; full contact in protected detail view
 */

import React from 'react';
import { useLiveJobs } from '@/hooks/useLiveJobs';
import { JobDetail } from '@/components/jobs/JobDetail';
import { maskPhoneNumber } from '@/services/liveJobs';
import type { JobRecord } from '@/types/operations';
import {
  Activity,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  WifiOff,
  AlertCircle,
  AlertTriangle,
  Clock,
  ShieldAlert,
  Filter,
} from 'lucide-react';

export const LiveJobsPage: React.FC = () => {
  const {
    selectedFilter,
    setSelectedFilter,
    jobs,
    selectedJobId,
    setSelectedJobId,
    selectedJob,
    selectedJobLoading,
    selectedJobFromCache,
    selectedRun,
    selectedRunLoading,
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
  } = useLiveJobs();

  const handleFilterChange = (newFilter: string) => {
    setSelectedFilter(newFilter);
    setSelectedJobId(null);
  };

  const formatTimestamp = (ts?: { toDate?: () => Date; seconds: number }) => {
    if (!ts) return 'Unavailable';
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts.seconds * 1000);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-indigo-600" />
            Live Jobs Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Real-time operational monitoring of active towing dispatches, driver offers, and trip progression.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <span className="text-[11px] text-slate-400 block">Last server confirmation</span>
            <span className="text-xs font-mono font-medium text-slate-700">
              {lastServerConfirmation ? lastServerConfirmation.toLocaleTimeString('en-IN') : 'Awaiting sync'}
            </span>
          </div>

          <button
            type="button"
            onClick={refresh}
            disabled={isLoading}
            className="p-2 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition-colors"
            title="Refresh from server"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Offline / Cached Warning Banner */}
      {isOffline && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs flex items-center gap-2">
          <WifiOff className="w-4 h-4 flex-shrink-0" />
          <span>You are currently offline or viewing cached snapshot data. Reconnecting to live stream...</span>
        </div>
      )}

      {/* Filter Chips Bar */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-slate-700 flex items-center gap-1 mr-1">
          <Filter className="w-3.5 h-3.5 text-slate-400" /> Filter:
        </span>

        <button
          type="button"
          onClick={() => handleFilterChange('all_active')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'all_active'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          All Active Operations (Paid)
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange('pending_offer')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'pending_offer'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Pending Offer
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange('offered')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'offered'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Offered
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange('accepted')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'accepted'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Accepted
        </button>

        <button
          type="button"
          onClick={() => handleFilterChange('in_progress')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'in_progress'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          In Progress
        </button>

        <div className="h-4 w-px bg-slate-300 mx-1 hidden sm:block" />

        <button
          type="button"
          onClick={() => handleFilterChange('awaiting_payment')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            selectedFilter === 'awaiting_payment'
              ? 'bg-indigo-600 text-white font-semibold shadow-sm'
              : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
          }`}
        >
          Awaiting Payment (Unpaid)
        </button>
      </div>

      {/* Two-Column Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Jobs Table (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
            {/* Table Header / Page indicator */}
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">
                Jobs ({jobs.length} displayed)
                {isLive ? (
                  <span className="ml-2 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-bold">
                    LIVE FIRST PAGE
                  </span>
                ) : (
                  <span className="ml-2 text-[10px] text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full font-medium">
                    SNAPSHOT PAGE {pageIndex + 1}
                  </span>
                )}
              </span>
              <span className="text-[11px] text-slate-400">Order: CreatedAt DESC</span>
            </div>

            {/* Error state */}
            {error && (
              <div className="p-4 bg-red-50 text-red-700 text-xs flex items-center gap-2 border-b border-red-100">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Table Body */}
            <div className="flex-1 overflow-auto divide-y divide-slate-100">
              {isLoading && jobs.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600 mb-2" />
                  Loading active operations...
                </div>
              ) : jobs.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  {isOffline ? 'Awaiting server sync...' : 'No jobs in this view.'}
                </div>
              ) : (
                jobs.map((job: JobRecord) => {
                  const isSelected = selectedJobId === job.id;

                  return (
                    <div
                      key={job.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedJobId(job.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedJobId(job.id);
                        }
                      }}
                      className={`p-3.5 text-left transition-colors cursor-pointer flex flex-col gap-1.5 ${
                        isSelected
                          ? 'bg-indigo-50/70 border-l-4 border-indigo-600'
                          : 'hover:bg-slate-50 border-l-4 border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900 font-mono text-xs">{job.id}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
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

                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span className="capitalize">{job.towingCategory || 'Towing'}</span>
                        <span className="font-mono text-slate-600">
                          {job.assignedDriver
                            ? `Driver: ${job.assignedDriver.slice(0, 10)}...`
                            : job.offeredTo
                            ? `Offered: ${job.offeredTo.slice(0, 10)}...`
                            : 'No Driver'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                        <span>Created: {formatTimestamp(job.createdAt)}</span>
                        <span className="font-mono">Phone: {maskPhoneNumber(job.customerPhone)}</span>
                      </div>

                      {/* Diagnostic badges */}
                      {(() => {
                        const isHold = job.dispatchState === 'operational_hold' || Boolean(job.operational_hold);
                        const isRetryWait = job.dispatchState === 'retry_wait' || (Boolean(job.dispatchNextActionAt) && !isHold);
                        const isCancellation =
                          job.cancellationResolutionState === 'pending' ||
                          Boolean(job.customerCancellationPending);

                        if (!isHold && !isRetryWait && !isCancellation) return null;

                        return (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {isHold && (
                              <span className="text-[10px] text-amber-800 font-bold bg-amber-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                                <ShieldAlert className="w-3 h-3 text-amber-600" /> Operational Hold
                              </span>
                            )}
                            {isRetryWait && (
                              <span className="text-[10px] text-blue-800 font-bold bg-blue-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                                <Clock className="w-3 h-3 text-blue-600" /> Retry Wait
                              </span>
                            )}
                            {isCancellation && (
                              <span className="text-[10px] text-indigo-800 font-bold bg-indigo-100 px-1.5 py-0.5 rounded flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3 text-indigo-600" /> Cancel Requested
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })
              )}
            </div>

            {/* Pagination Controls */}
            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goToPreviousPage}
                  disabled={pageIndex === 0 || isLoading}
                  className="px-3 py-1.5 border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Previous
                </button>
                {pageIndex > 0 && (
                  <button
                    type="button"
                    onClick={backToLive}
                    disabled={isLoading}
                    className="px-2.5 py-1.5 border border-indigo-300 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium flex items-center gap-1"
                  >
                    Back to Live
                  </button>
                )}
              </div>

              <span className="text-[11px] text-slate-500 font-mono">
                Page {pageIndex + 1}
              </span>

              <button
                type="button"
                onClick={goToNextPage}
                disabled={!hasMore || isLoading}
                className="px-3 py-1.5 border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Selected Job Details & Candidate Evidence (7 cols) */}
        <div className="lg:col-span-7">
          <JobDetail
            job={selectedJob}
            loading={selectedJobLoading}
            isFromCache={selectedJobFromCache}
            dispatchRun={selectedRun}
            runLoading={selectedRunLoading}
            driverIdentities={driverIdentities}
            identityLoading={identityLoading}
            onLoadDriverIdentity={loadDriverIdentity}
          />
        </div>
      </div>
    </div>
  );
};
