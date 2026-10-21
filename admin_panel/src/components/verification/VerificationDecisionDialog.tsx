/**
 * TowMitra Phase 6 M2 — Verification Decision Dialog Component (M2-ARCH-1, Section 3 & Owner Decisions O1, O2)
 *
 * Implements:
 * - Approval with explicit literal boolean capabilities: canFlatbed, canPulling.
 *   Neither defaults to approved; neither is inferred from truckType (Owner Decision O1).
 *   At least one must be checked.
 * - Rejection with plain text reason: 10-500 code points, normalized, no control characters (Owner Decision O2).
 * - Fenced review context with stable requestId generation for idempotent retry.
 */

import React, { useState } from 'react';
import type { DriverProfile } from '@/types/operations';
import { CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';

interface VerificationDecisionDialogProps {
  mode: 'approve' | 'reject';
  driver: DriverProfile;
  isOpen: boolean;
  onClose: () => void;
  onConfirmApprove: (params: { canFlatbed: boolean; canPulling: boolean; requestId: string }) => Promise<void>;
  onConfirmReject: (params: { reason: string; requestId: string }) => Promise<void>;
  isSubmitting: boolean;
  error: string | null;
  isOffline?: boolean;
  isFromCache?: boolean;
}

function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

export const VerificationDecisionDialog: React.FC<VerificationDecisionDialogProps> = ({
  mode,
  driver,
  isOpen,
  onClose,
  onConfirmApprove,
  onConfirmReject,
  isSubmitting,
  error,
  isOffline = false,
  isFromCache = false,
}) => {
  // Stable requestId per decision dialog session
  const [requestId] = useState(() => crypto.randomUUID());

  // Approval capabilities (neither defaults to true, no inference from truckType)
  const [canFlatbed, setCanFlatbed] = useState(false);
  const [canPulling, setCanPulling] = useState(false);

  // Rejection reason
  const [reason, setReason] = useState('');

  // Frozen submitted values (once submitted, cannot be mutated under this requestId)
  const [submittedValues, setSubmittedValues] = useState<{
    canFlatbed?: boolean;
    canPulling?: boolean;
    reason?: string;
  } | null>(null);

  if (!isOpen) return null;

  // Validation
  const trimmedReason = reason.normalize('NFC').trim();
  const reasonCodePoints = Array.from(trimmedReason).length;
  const isReasonValid = reasonCodePoints >= 10 && reasonCodePoints <= 500 && !hasControlCharacters(trimmedReason);
  const isApproveValid = canFlatbed || canPulling;
  const isActionDisabled =
    isSubmitting ||
    isOffline ||
    isFromCache ||
    (submittedValues ? false : mode === 'approve' ? !isApproveValid : !isReasonValid);
  const isInputsDisabled = isSubmitting || Boolean(submittedValues) || isOffline || isFromCache;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || isFromCache) return;
    if (mode === 'approve') {
      const activeCanFlatbed = submittedValues ? Boolean(submittedValues.canFlatbed) : canFlatbed;
      const activeCanPulling = submittedValues ? Boolean(submittedValues.canPulling) : canPulling;
      if (!activeCanFlatbed && !activeCanPulling) return;
      if (!submittedValues) {
        setSubmittedValues({ canFlatbed: activeCanFlatbed, canPulling: activeCanPulling });
      }
      await onConfirmApprove({ canFlatbed: activeCanFlatbed, canPulling: activeCanPulling, requestId });
    } else {
      const activeReason = submittedValues ? (submittedValues.reason || '') : trimmedReason;
      const activeCodePoints = Array.from(activeReason).length;
      if (activeCodePoints < 10 || activeCodePoints > 500 || hasControlCharacters(activeReason)) return;
      if (!submittedValues) {
        setSubmittedValues({ reason: activeReason });
      }
      await onConfirmReject({ reason: activeReason, requestId });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-200">
        <div className={`px-6 py-4 border-b flex items-center gap-3 ${mode === 'approve' ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'}`}>
          {mode === 'approve' ? (
            <CheckCircle2 className="w-6 h-6 text-emerald-600 flex-shrink-0" />
          ) : (
            <XCircle className="w-6 h-6 text-red-600 flex-shrink-0" />
          )}
          <div>
            <h2 className="text-base font-bold text-slate-900">
              {mode === 'approve' ? 'Approve Driver Verification' : 'Reject Driver Application'}
            </h2>
            <p className="text-xs text-slate-500">
              Target: <span className="font-mono text-slate-700">{driver.uid}</span> ({driver.name})
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {(isOffline || isFromCache) && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>
                {isOffline
                  ? 'System is currently offline. Decision submission is disabled until online connectivity is restored.'
                  : 'Application data is served from local cache. Decisions require active online server confirmation.'}
              </span>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {mode === 'approve' ? (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                <p className="font-medium text-slate-800 mb-1">Explicit Driver Capabilities (Owner Decision O1)</p>
                <p>Select the verified operational towing capabilities based on the reviewed RC and vehicle photos. Do not infer capabilities from descriptive truck type.</p>
              </div>

              <div className="space-y-3 pt-2">
                <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canFlatbed}
                    onChange={(e) => setCanFlatbed(e.target.checked)}
                    disabled={isInputsDisabled}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <span className="text-sm font-semibold text-slate-800">Flatbed Towing (canFlatbed)</span>
                    <p className="text-xs text-slate-500">Qualified and equipped for full flatbed carrier transportation.</p>
                  </div>
                </label>

                <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canPulling}
                    onChange={(e) => setCanPulling(e.target.checked)}
                    disabled={isInputsDisabled}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div>
                    <span className="text-sm font-semibold text-slate-800">Pulling / Tochan Towing (canPulling)</span>
                    <p className="text-xs text-slate-500">Qualified and equipped for under-lift, wheel-lift, or tochan towing.</p>
                  </div>
                </label>
              </div>

              {!isApproveValid && (
                <p className="text-xs text-red-600 font-medium">
                  At least one operational capability must be selected to approve.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                <p className="font-medium text-slate-800 mb-1">Rejection Reason (Owner Decision O2)</p>
                <p>Provide a clear, human-readable reason (10–500 characters). This will be persisted and displayed to the driver in the mobile app for resubmission.</p>
              </div>

              <div>
                <label htmlFor="rejection-reason" className="block text-xs font-semibold text-slate-700 mb-1">
                  Reason for Rejection
                </label>
                <textarea
                  id="rejection-reason"
                  rows={4}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={isInputsDisabled}
                  placeholder="e.g. Uploaded vehicle RC photo is blurred and the registration number cannot be verified. Please re-upload a clear photo."
                  className="w-full text-xs p-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                />
                <div className="flex justify-between items-center text-[11px] text-slate-500 mt-1">
                  <span>Plain text only, no control characters.</span>
                  <span className={reasonCodePoints < 10 || reasonCodePoints > 500 ? 'text-amber-600 font-medium' : 'text-slate-500'}>
                    {reasonCodePoints} / 500 characters (min 10)
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isActionDisabled}
              className={`px-5 py-2 text-xs font-semibold rounded-lg text-white shadow-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                mode === 'approve'
                  ? 'bg-emerald-600 hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-500'
                  : 'bg-red-600 hover:bg-red-700 focus:ring-2 focus:ring-red-500'
              }`}
            >
              {isSubmitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {mode === 'approve' ? 'Confirm Approval' : 'Confirm Rejection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
