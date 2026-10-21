/**
 * TowMitra Phase 6 M2 — Driver Verification Queue Page (M2-ARCH-1, Section 3)
 *
 * Implements:
 * - Tabs: Pending (default), Approved, Rejected
 * - Bounded queue table: 25 rows, live first page, bounded server snapshot older pages
 * - Profile creation order vs application submission time distinction
 * - Two-column responsive review workspace with VerificationDetail & EvidenceViewer
 * - Offline / Stale data indicator and explicit server refresh
 */

import React from 'react';
import { useVerificationQueue, isProfileEnvelopeInvalid } from '@/hooks/useVerificationQueue';
import { VerificationDetail } from '@/components/verification/VerificationDetail';
import type { VerificationStatus, DriverProfile } from '@/types/operations';
import {
  ShieldCheck,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  WifiOff,
  AlertCircle,
} from 'lucide-react';

export const DriverVerificationQueuePage: React.FC = () => {
  const {
    statusTab,
    setStatusTab,
    drivers,
    selectedDriverUid,
    setSelectedDriverUid,
    selectedDriver,
    selectedDriverLoading,
    selectedDriverFromCache,
    evidence,
    evidenceLoading,
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
    retryEvidenceFile,
  } = useVerificationQueue();

  const handleTabChange = (newTab: VerificationStatus) => {
    setStatusTab(newTab);
    setSelectedDriverUid(null);
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

  const selectedDecision = selectedDriverUid ? submittedDecisions.get(selectedDriverUid) : undefined;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-indigo-600" />
            Driver Verification Queue
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Review submitted KYC applications, verify vehicle RC against profile, and approve or reject drivers.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Last server confirmation */}
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
          <span>You are currently offline or viewing cached snapshot data. Decisions are disabled until reconnection.</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-4 rounded-t-xl">
        <button
          type="button"
          onClick={() => handleTabChange('pending')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
            statusTab === 'pending'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Clock className="w-4 h-4" />
          Pending Review
        </button>

        <button
          type="button"
          onClick={() => handleTabChange('approved')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
            statusTab === 'approved'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <CheckCircle className="w-4 h-4" />
          Approved Roster
        </button>

        <button
          type="button"
          onClick={() => handleTabChange('rejected')}
          className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
            statusTab === 'rejected'
              ? 'border-red-600 text-red-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <XCircle className="w-4 h-4" />
          Rejected Applications
        </button>
      </div>

      {/* Two-Column Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Applications Table (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
            {/* Table Header / Page indicator */}
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">
                Queue ({drivers.length} displayed)
                {isOffline ? (
                  <span className="ml-2 text-[10px] text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full font-bold">
                    OFFLINE / CACHED
                  </span>
                ) : isLive ? (
                  <span className="ml-2 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full font-bold">
                    LIVE FIRST PAGE
                  </span>
                ) : (
                  <span className="ml-2 text-[10px] text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full font-medium">
                    SNAPSHOT PAGE {pageIndex + 1}
                  </span>
                )}
              </span>
              <span className="text-[11px] text-slate-400">Order: Profile Created ASC</span>
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
              {isLoading && drivers.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600 mb-2" />
                  Loading application queue...
                </div>
              ) : drivers.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  {isOffline ? 'Awaiting server sync...' : `No ${statusTab} applications found in this view.`}
                </div>
              ) : (
                drivers.map((drv: DriverProfile) => {
                  const isSelected = selectedDriverUid === drv.uid;
                  const isSchemaInvalid = isProfileEnvelopeInvalid(drv);

                  return (
                    <div
                      key={drv.uid}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedDriverUid(drv.uid)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedDriverUid(drv.uid);
                        }
                      }}
                      className={`p-3.5 text-left transition-colors cursor-pointer flex flex-col gap-1.5 ${
                        isSelected
                          ? 'bg-indigo-50/70 border-l-4 border-indigo-600'
                          : 'hover:bg-slate-50 border-l-4 border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900 text-xs">{drv.name || 'Unnamed Profile'}</span>
                        <span className="text-[11px] font-mono font-semibold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                          {drv.vehicleNumber || 'No Plate'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span className="font-mono text-[10px] text-slate-400">UID: {drv.uid.slice(0, 16)}...</span>
                        <span className="capitalize">{drv.truckType || 'Unknown'}</span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                        <span>Submitted: {formatTimestamp(drv.verificationDocs?.submittedAt)}</span>
                        {isSchemaInvalid && (
                          <span className="text-red-600 font-bold uppercase bg-red-50 px-1 rounded">
                            Schema Invalid
                          </span>
                        )}
                      </div>
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

        {/* Right Column: Application Detail & Evidence (7 cols) */}
        <div className="lg:col-span-7">
          <VerificationDetail
            driver={selectedDriver}
            loading={selectedDriverLoading}
            isFromCache={selectedDriverFromCache}
            isOffline={isOffline}
            evidence={evidence}
            evidenceLoading={evidenceLoading}
            submittedDecision={selectedDecision}
            onApprove={async (p) => { await approveDriver(p); }}
            onReject={async (p) => { await rejectDriver(p); }}
            onRetryDecision={async (uid) => { await retryDecision(uid); }}
            onRetryFile={retryEvidenceFile}
          />
        </div>
      </div>
    </div>
  );
};
