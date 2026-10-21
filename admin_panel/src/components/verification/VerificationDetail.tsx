/**
 * TowMitra Phase 6 M2 — Verification Detail Component (M2-ARCH-1, Section 3 & Owner Decisions O1, O2, O3)
 *
 * Implements:
 * - Driver application details and status inspection
 * - Frozen reviewed application context when confirmation dialog opens
 * - Stale review invalidation on application version, timestamp, profile or status changes
 * - Explicit literal boolean capabilities for approval (canFlatbed, canPulling)
 * - Persisted human-readable rejection reasons (10-500 chars, no control chars)
 * - Operational Provisioning Diagnostic (Owner Decision O3: identifies missing & malformed fields)
 * - Schema Invalid profile envelope diagnostic and disablement
 * - Idempotent retry / reconciliation affordance for unknown or failed outcomes
 * - Fully fenced against offline state, cached data, and unverified evidence
 */

import React, { useState } from 'react';
import type {
  DriverProfile,
  EvidenceState,
  SubmittedDecision,
  ExactTimestamp,
  VerificationStatus,
} from '@/types/operations';
import { isProfileEnvelopeInvalid, createInitialEvidenceState } from '@/hooks/useVerificationQueue';
import { EvidenceViewer } from './EvidenceViewer';
import { VerificationDecisionDialog } from './VerificationDecisionDialog';
import {
  User,
  Phone,
  Truck,
  FileText,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';

interface ReviewedContext {
  driverUid: string;
  updatedAt: ExactTimestamp;
  submittedAt: ExactTimestamp;
  name: string;
  verificationStatus: VerificationStatus;
  evidenceGenerations?: { id: string; rc: string; selfie: string };
}

interface VerificationDetailProps {
  driver: DriverProfile | null;
  loading: boolean;
  isFromCache: boolean;
  isOffline?: boolean;
  evidence: EvidenceState;
  evidenceLoading: boolean;
  submittedDecision?: SubmittedDecision;
  onApprove: (params: {
    canFlatbed: boolean;
    canPulling: boolean;
    requestId: string;
    expectedUpdatedAt: ExactTimestamp;
    expectedSubmittedAt: ExactTimestamp;
  }) => Promise<void>;
  onReject: (params: {
    reason: string;
    requestId: string;
    expectedUpdatedAt: ExactTimestamp;
    expectedSubmittedAt: ExactTimestamp;
  }) => Promise<void>;
  onRetryDecision?: (driverUid: string) => Promise<void>;
  onRetryFile?: (docKey: 'id' | 'rc' | 'selfie') => void;
}

export const VerificationDetail: React.FC<VerificationDetailProps> = ({
  driver,
  loading,
  isFromCache,
  isOffline = false,
  evidence,
  evidenceLoading,
  submittedDecision,
  onApprove,
  onReject,
  onRetryDecision,
  onRetryFile,
}) => {
  const [dialogMode, setDialogMode] = useState<'approve' | 'reject' | null>(null);
  const [reviewedContext, setReviewedContext] = useState<ReviewedContext | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [staleReviewAlert, setStaleReviewAlert] = useState<string | null>(null);

  // Invalidate open confirmation dialog and reviewed evidence if underlying driver record changes
  const isStaleReview = Boolean(
    reviewedContext &&
      (!driver ||
        driver.uid !== reviewedContext.driverUid ||
        driver.updatedAt?.seconds !== reviewedContext.updatedAt.seconds ||
        driver.updatedAt?.nanoseconds !== reviewedContext.updatedAt.nanoseconds ||
        driver.verificationDocs?.submittedAt?.seconds !== reviewedContext.submittedAt.seconds ||
        driver.verificationDocs?.submittedAt?.nanoseconds !== reviewedContext.submittedAt.nanoseconds ||
        driver.name !== reviewedContext.name ||
        driver.verificationStatus !== reviewedContext.verificationStatus ||
        (reviewedContext.evidenceGenerations &&
          (!evidence.allDecoded ||
            evidence.id.generation !== reviewedContext.evidenceGenerations.id ||
            evidence.rc.generation !== reviewedContext.evidenceGenerations.rc ||
            evidence.selfie.generation !== reviewedContext.evidenceGenerations.selfie)))
  );

  const effectiveDialogMode = isStaleReview ? null : dialogMode;
  const effectiveEvidence = isStaleReview ? createInitialEvidenceState() : evidence;

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-500 bg-white rounded-xl border border-slate-200">
        <RotateCcw className="w-8 h-8 animate-spin mx-auto text-indigo-600 mb-2" />
        <p className="text-sm font-medium">Loading application detail...</p>
      </div>
    );
  }

  if (!driver) {
    return (
      <div className="p-8 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
        <User className="w-10 h-10 mx-auto text-slate-300 mb-2" />
        <p className="text-sm font-medium text-slate-600">Select a driver from the queue</p>
        <p className="text-xs text-slate-400 mt-1">Click any application row to inspect KYC evidence and details.</p>
      </div>
    );
  }

  // Profile Envelope Validation
  const isSchemaInvalid = isProfileEnvelopeInvalid(driver);

  // Diagnostic: identify missing and malformed operational provisioning fields (Owner Decision O3)
  const missingProvisioningFields: string[] = [];
  const malformedProvisioningFields: string[] = [];

  if (driver.walletBalance === undefined) missingProvisioningFields.push('walletBalance');
  else if (
    typeof driver.walletBalance !== 'number' ||
    !Number.isSafeInteger(driver.walletBalance) ||
    driver.walletBalance < 0
  ) {
    malformedProvisioningFields.push('walletBalance (non-negative safe integer paise)');
  }

  if (driver.activeJobId === undefined) missingProvisioningFields.push('activeJobId');
  else if (driver.activeJobId !== null && (typeof driver.activeJobId !== 'string' || driver.activeJobId.trim() === '')) {
    malformedProvisioningFields.push('activeJobId (null or non-empty string)');
  }

  if (driver.activeOfferId === undefined) missingProvisioningFields.push('activeOfferId');
  else if (driver.activeOfferId !== null && (typeof driver.activeOfferId !== 'string' || driver.activeOfferId.trim() === '')) {
    malformedProvisioningFields.push('activeOfferId (null or non-empty string)');
  }

  if (driver.dutySessionId === undefined) missingProvisioningFields.push('dutySessionId');
  else if (driver.dutySessionId !== null && (typeof driver.dutySessionId !== 'string' || driver.dutySessionId.trim() === '')) {
    malformedProvisioningFields.push('dutySessionId (null or non-empty string)');
  }

  if (driver.bannedUntil === undefined) missingProvisioningFields.push('bannedUntil');
  else if (driver.bannedUntil !== null) {
    const bu = driver.bannedUntil as { seconds?: unknown; nanoseconds?: unknown; toDate?: () => unknown };
    let isValid = false;
    if (typeof bu === 'object' && bu !== null) {
      if (typeof bu.toDate === 'function') {
        try {
          const d = bu.toDate();
          if (d instanceof Date && !isNaN(d.getTime())) isValid = true;
        } catch {
          isValid = false;
        }
      }
      if (
        !isValid &&
        typeof bu.seconds === 'number' &&
        Number.isSafeInteger(bu.seconds) &&
        typeof bu.nanoseconds === 'number' &&
        Number.isSafeInteger(bu.nanoseconds) &&
        bu.seconds >= -62135596800 &&
        bu.seconds <= 253402300799 &&
        bu.nanoseconds >= 0 &&
        bu.nanoseconds <= 999999999
      ) {
        isValid = true;
      }
    }
    if (!isValid) {
      malformedProvisioningFields.push('bannedUntil (null or valid timestamp with safe integer seconds and nanoseconds [0..1e9))');
    }
  }

  if (driver.strictMode === undefined) missingProvisioningFields.push('strictMode');
  else if (typeof driver.strictMode !== 'boolean') {
    malformedProvisioningFields.push('strictMode (boolean)');
  }

  if (driver.monthlyCancelCount === undefined) missingProvisioningFields.push('monthlyCancelCount');
  else {
    const mcc = driver.monthlyCancelCount as unknown;
    const isCanonicalMap =
      typeof mcc === 'object' &&
      mcc !== null &&
      typeof (mcc as { month?: unknown }).month === 'string' &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test((mcc as { month: string }).month) &&
      typeof (mcc as { count?: unknown }).count === 'number' &&
      Number.isSafeInteger((mcc as { count: number }).count) &&
      (mcc as { count: number }).count >= 0;
    if (!isCanonicalMap) {
      malformedProvisioningFields.push('monthlyCancelCount (canonical {month: YYYY-MM, count: non-negative integer} map)');
    }
  }

  if (driver.workerReady === undefined) missingProvisioningFields.push('workerReady');
  else if (typeof driver.workerReady !== 'boolean') {
    malformedProvisioningFields.push('workerReady (boolean)');
  }

  if (driver.isOnDuty === undefined) missingProvisioningFields.push('isOnDuty');
  else if (typeof driver.isOnDuty !== 'boolean') {
    malformedProvisioningFields.push('isOnDuty (boolean)');
  }

  const hasProvisioningDiagnostic = missingProvisioningFields.length > 0 || malformedProvisioningFields.length > 0;

  const formatTimestamp = (ts?: { toDate?: () => Date; seconds: number }) => {
    if (!ts) return 'Unavailable';
    const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts.seconds * 1000);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  };

  const openApprovalDialog = () => {
    if (!driver || !driver.verificationDocs || !evidence.allDecoded || isStaleReview) return;
    setReviewedContext({
      driverUid: driver.uid,
      updatedAt: { seconds: driver.updatedAt.seconds, nanoseconds: driver.updatedAt.nanoseconds },
      submittedAt: {
        seconds: driver.verificationDocs.submittedAt.seconds,
        nanoseconds: driver.verificationDocs.submittedAt.nanoseconds,
      },
      name: driver.name,
      verificationStatus: driver.verificationStatus,
      evidenceGenerations: {
        id: evidence.id.generation || '',
        rc: evidence.rc.generation || '',
        selfie: evidence.selfie.generation || '',
      },
    });
    setStaleReviewAlert(null);
    setDialogMode('approve');
  };

  const openRejectionDialog = () => {
    if (!driver || !driver.verificationDocs || isStaleReview) return;
    setReviewedContext({
      driverUid: driver.uid,
      updatedAt: { seconds: driver.updatedAt.seconds, nanoseconds: driver.updatedAt.nanoseconds },
      submittedAt: {
        seconds: driver.verificationDocs.submittedAt.seconds,
        nanoseconds: driver.verificationDocs.submittedAt.nanoseconds,
      },
      name: driver.name,
      verificationStatus: driver.verificationStatus,
    });
    setStaleReviewAlert(null);
    setDialogMode('reject');
  };

  const handleConfirmApprove = async (params: { canFlatbed: boolean; canPulling: boolean; requestId: string }) => {
    if (!reviewedContext) return;
    setSubmitting(true);
    setDecisionError(null);
    try {
      await onApprove({
        ...params,
        expectedUpdatedAt: reviewedContext.updatedAt,
        expectedSubmittedAt: reviewedContext.submittedAt,
      });
      setDialogMode(null);
      setReviewedContext(null);
    } catch (err: unknown) {
      setDecisionError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmReject = async (params: { reason: string; requestId: string }) => {
    if (!reviewedContext) return;
    setSubmitting(true);
    setDecisionError(null);
    try {
      await onReject({
        ...params,
        expectedUpdatedAt: reviewedContext.updatedAt,
        expectedSubmittedAt: reviewedContext.submittedAt,
      });
      setDialogMode(null);
      setReviewedContext(null);
    } catch (err: unknown) {
      setDecisionError(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setSubmitting(false);
    }
  };

  const isPending = driver.verificationStatus === 'pending';
  const hasInFlightDecision = submittedDecision?.status === 'in_flight';
  const canDecide =
    isPending &&
    !isFromCache &&
    !isOffline &&
    !isSchemaInvalid &&
    effectiveEvidence.allDecoded &&
    !evidenceLoading &&
    !isStaleReview &&
    !hasInFlightDecision;
  const canReject =
    isPending &&
    !isFromCache &&
    !isOffline &&
    !isSchemaInvalid &&
    !isStaleReview &&
    !hasInFlightDecision;

  return (
    <div className="space-y-6">
      {/* Top Banner / Stale Warning */}
      {isFromCache && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>Application details loaded from local cache. Decisions are disabled until server confirmation.</span>
        </div>
      )}

      {isOffline && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>System is currently offline. Review decisions are disabled until connection is restored.</span>
        </div>
      )}

      {(staleReviewAlert || isStaleReview) && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 text-red-600" />
            <span>
              {staleReviewAlert ||
                'Driver application was modified on the server while confirmation was open. Review invalidated — please review the latest version.'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setStaleReviewAlert(null);
              setReviewedContext(null);
              setDialogMode(null);
            }}
            className="px-2.5 py-1 bg-white border border-red-300 rounded text-red-700 font-semibold text-[11px] hover:bg-red-50 flex-shrink-0 shadow-sm"
          >
            Acknowledge & Re-review
          </button>
        </div>
      )}

      {isSchemaInvalid && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-red-600" />
          <span>Driver profile envelope is malformed or missing required fields. Decisions are disabled.</span>
        </div>
      )}

      {/* Decision Submitted Feedback */}
      {submittedDecision && (
        <div
          className={`p-3 rounded-lg border text-xs flex items-center justify-between ${
            submittedDecision.status === 'committed'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : submittedDecision.status === 'failed'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-blue-50 border-blue-200 text-blue-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {submittedDecision.status === 'committed' ? (
              <CheckCircle className="w-4 h-4 text-emerald-600" />
            ) : submittedDecision.status === 'failed' ? (
              <XCircle className="w-4 h-4 text-red-600" />
            ) : (
              <RotateCcw className="w-4 h-4 animate-spin text-blue-600" />
            )}
            <span>
              Decision {submittedDecision.status}: {submittedDecision.operation} (Request ID: {submittedDecision.requestId.slice(0, 8)}...)
              {submittedDecision.error ? ` — ${submittedDecision.error}` : ''}
            </span>
          </div>
          {submittedDecision.status === 'failed' && (
            <button
              type="button"
              onClick={async () => {
                if (onRetryDecision) {
                  await onRetryDecision(driver.uid);
                } else if (submittedDecision.operation === 'adminApproveDriver') {
                  openApprovalDialog();
                } else {
                  openRejectionDialog();
                }
              }}
              className="px-2.5 py-1 bg-white border border-red-300 rounded text-red-700 font-semibold text-[11px] hover:bg-red-50 flex items-center gap-1 shadow-sm"
            >
              <RotateCcw className="w-3 h-3" />
              Retry Decision
            </button>
          )}
        </div>
      )}

      {/* Profile Card */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900">{driver.name || 'Unnamed Profile'}</h2>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase ${
                  driver.verificationStatus === 'approved'
                    ? 'bg-emerald-100 text-emerald-800'
                    : driver.verificationStatus === 'rejected'
                    ? 'bg-red-100 text-red-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {driver.verificationStatus}
              </span>
              {isSchemaInvalid && (
                <span className="px-2 py-0.5 rounded text-[11px] font-bold uppercase bg-red-100 text-red-800">
                  Schema Invalid
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-slate-500 mt-0.5">UID: {driver.uid}</p>
          </div>

          {/* Action buttons (only for pending) */}
          {isPending && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openRejectionDialog}
                disabled={!canReject}
                className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50"
              >
                Reject Application
              </button>
              <button
                type="button"
                onClick={openApprovalDialog}
                disabled={!canDecide}
                title={!evidence.allDecoded ? 'All 3 preview images must decode first' : ''}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                Approve Driver
              </button>
            </div>
          )}
        </div>

        {/* Profile Details Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Phone</span>
              <span className="font-mono text-slate-700">{driver.phone || 'Unavailable'}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Vehicle Registration</span>
              <span className="font-mono font-semibold text-slate-800">{driver.vehicleNumber || 'Unavailable'}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Truck Type (Descriptive)</span>
              <span className="capitalize text-slate-700">{driver.truckType || 'Unavailable'}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Submitted At</span>
              <span className="text-slate-700">{formatTimestamp(driver.verificationDocs?.submittedAt)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Last Updated At</span>
              <span className="text-slate-700">{formatTimestamp(driver.updatedAt)}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            <div>
              <span className="text-slate-400 block">Created At</span>
              <span className="text-slate-700">{formatTimestamp(driver.createdAt)}</span>
            </div>
          </div>
        </div>

        {/* Capabilities (if approved) */}
        {driver.verificationStatus === 'approved' && (
          <div className="p-3 bg-emerald-50/60 border border-emerald-100 rounded-lg text-xs space-y-1">
            <span className="font-semibold text-emerald-900">Approved Towing Capabilities:</span>
            <div className="flex gap-4 pt-1">
              <span className={`font-medium ${driver.canFlatbed ? 'text-emerald-700' : 'text-slate-400'}`}>
                • Flatbed Towing: {driver.canFlatbed ? 'Yes' : 'No'}
              </span>
              <span className={`font-medium ${driver.canPulling ? 'text-emerald-700' : 'text-slate-400'}`}>
                • Pulling / Tochan Towing: {driver.canPulling ? 'Yes' : 'No'}
              </span>
            </div>
          </div>
        )}

        {/* Rejection Reason (if rejected) */}
        {driver.verificationStatus === 'rejected' && driver.rejectionReason && (
          <div className="p-3 bg-red-50/60 border border-red-100 rounded-lg text-xs space-y-1">
            <span className="font-semibold text-red-900">Persisted Rejection Reason:</span>
            <p className="text-red-800 font-medium whitespace-pre-wrap">{driver.rejectionReason}</p>
          </div>
        )}

        {/* Operational Provisioning Diagnostic (Owner Decision O3) */}
        {hasProvisioningDiagnostic && (
          <div className="p-3 bg-slate-100 border border-slate-200 rounded-lg text-xs space-y-1.5 text-slate-700">
            <div className="flex items-center gap-1.5 font-semibold text-slate-800">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              <span>Operational Provisioning Diagnostic (Owner Decision O3)</span>
            </div>
            <p className="text-slate-600">
              {driver.verificationStatus === 'approved'
                ? 'KYC approved; operational provisioning may be incomplete.'
                : 'KYC review only; new driver profiles are created without initial operational defaults.'}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {missingProvisioningFields.map((f) => (
                <span key={f} className="px-2 py-0.5 bg-white border border-slate-300 rounded text-[11px] font-mono text-slate-600">
                  missing: {f}
                </span>
              ))}
              {malformedProvisioningFields.map((f) => (
                <span key={f} className="px-2 py-0.5 bg-red-50 border border-red-300 rounded text-[11px] font-mono text-red-700">
                  malformed: {f}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 italic mt-1">
              This is an informational diagnostic. M2 does not auto-initialize duty or financial fields.
            </p>
          </div>
        )}
      </div>

      {/* KYC Evidence Viewer */}
      <EvidenceViewer
        evidence={effectiveEvidence}
        loading={evidenceLoading}
        status={driver.verificationStatus}
        onRetryFile={onRetryFile}
      />

      {/* Decision Dialog Modal */}
      {effectiveDialogMode && (
        <VerificationDecisionDialog
          mode={effectiveDialogMode}
          driver={driver}
          isOpen={true}
          onClose={() => {
            setDialogMode(null);
            setReviewedContext(null);
          }}
          onConfirmApprove={handleConfirmApprove}
          onConfirmReject={handleConfirmReject}
          isSubmitting={submitting}
          error={decisionError}
          isOffline={isOffline}
          isFromCache={isFromCache}
        />
      )}
    </div>
  );
};
