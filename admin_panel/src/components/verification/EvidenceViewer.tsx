/**
 * TowMitra Phase 6 M2 — Evidence Viewer Component (M2-ARCH-1, Section 3)
 *
 * In-memory data URL evidence preview for ID, RC, and Selfie.
 * Private, authenticated, bounded memory-only rendering.
 * Does not use public URLs, signed URLs, or persistent browser storage.
 */

import React, { useState } from 'react';
import type { EvidenceState, VerificationStatus } from '@/types/operations';
import { Eye, AlertTriangle, RefreshCw, ZoomIn, ZoomOut, X } from 'lucide-react';

interface EvidenceViewerProps {
  evidence: EvidenceState;
  loading: boolean;
  status: VerificationStatus;
  onRetryFile?: (docKey: 'id' | 'rc' | 'selfie') => void;
}

export const EvidenceViewer: React.FC<EvidenceViewerProps> = ({
  evidence,
  loading,
  status,
  onRetryFile,
}) => {
  const [modalImage, setModalImage] = useState<{ title: string; src: string } | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [prevEvidence, setPrevEvidence] = useState(evidence);

  if (prevEvidence !== evidence) {
    setPrevEvidence(evidence);
    setModalImage(null);
  }

  const files = [
    { title: 'Identity Document (ID)', fileState: evidence.id },
    { title: 'Vehicle Registration (RC)', fileState: evidence.rc },
    { title: 'Driver Selfie', fileState: evidence.selfie },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
          <Eye className="w-4 h-4 text-indigo-600" />
          KYC Evidence Previews (Authenticated Memory-Only)
        </h3>
        {status === 'rejected' && (
          <span className="text-xs text-amber-600 font-medium">
            Current stored evidence; may change before resubmission.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {files.map(({ title, fileState }) => (
          <div
            key={fileState.docKey}
            className="border border-slate-200 rounded-lg p-3 bg-slate-50 flex flex-col items-center justify-between min-h-[220px]"
          >
            <div className="w-full flex justify-between items-center mb-2">
              <span className="text-xs font-semibold text-slate-700">{title}</span>
              {fileState.generation && (
                <span className="text-[10px] text-slate-400 font-mono" title={`Storage Generation: ${fileState.generation}`}>
                  gen:{fileState.generation.slice(-6)}
                </span>
              )}
            </div>

            <div className="w-full h-36 bg-slate-200 rounded flex items-center justify-center overflow-hidden relative">
              {loading || fileState.loading ? (
                <div className="flex flex-col items-center text-slate-500 gap-1">
                  <RefreshCw className="w-6 h-6 animate-spin text-indigo-600" />
                  <span className="text-xs">Loading preview...</span>
                </div>
              ) : fileState.error ? (
                <div className="flex flex-col items-center text-red-600 p-2 text-center">
                  <AlertTriangle className="w-6 h-6 mb-1" />
                  <span className="text-xs font-medium">{fileState.error}</span>
                  {onRetryFile && (
                    <button
                      type="button"
                      onClick={() => onRetryFile(fileState.docKey)}
                      className="mt-2 px-2 py-0.5 text-[11px] font-semibold bg-red-100 hover:bg-red-200 text-red-800 rounded border border-red-300 flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                  )}
                </div>
              ) : fileState.dataUrl ? (
                <div className="relative group w-full h-full flex items-center justify-center">
                  <img
                    src={fileState.dataUrl}
                    alt={title}
                    className="max-h-full max-w-full object-contain cursor-pointer"
                    onClick={() => {
                      setZoomLevel(1);
                      setModalImage({ title, src: fileState.dataUrl! });
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setZoomLevel(1);
                      setModalImage({ title, src: fileState.dataUrl! });
                    }}
                    className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white transition-opacity text-xs font-medium gap-1"
                  >
                    <ZoomIn className="w-4 h-4" /> Click to expand
                  </button>
                </div>
              ) : (
                <span className="text-xs text-slate-400">No document uploaded</span>
              )}
            </div>

            <div className="w-full text-[11px] text-slate-500 mt-2 flex justify-between">
              <span>{fileState.filename}</span>
              <span>{fileState.size > 0 ? `${(fileState.size / 1024).toFixed(1)} KB` : ''}</span>
            </div>
          </div>
        ))}
      </div>

      {/* In-Memory Zoom Modal (Optional accessible preview enhancement) */}
      {modalImage && (
        <div className="fixed inset-0 z-50 bg-black/75 flex flex-col items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <span className="font-semibold text-slate-800 text-sm">{modalImage.title}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.max(0.5, z - 0.25))}
                  className="p-1 rounded hover:bg-slate-100 text-slate-600"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs text-slate-500 font-mono">{Math.round(zoomLevel * 100)}%</span>
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
                  className="p-1 rounded hover:bg-slate-100 text-slate-600"
                  title="Zoom In"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setModalImage(null)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-600 ml-2"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-slate-900/10">
              <img
                src={modalImage.src}
                alt={modalImage.title}
                style={{ transform: `scale(${zoomLevel})`, transformOrigin: 'center center' }}
                className="transition-transform max-h-[70vh] object-contain shadow"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
