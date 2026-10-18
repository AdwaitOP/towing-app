import React, { useEffect, useRef } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface ErrorBannerProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  isRetrying?: boolean;
  autoFocus?: boolean;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  title = 'System Error',
  message,
  onRetry,
  retryLabel = 'Retry Verification',
  isRetrying = false,
  autoFocus = true,
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) {
      if (buttonRef.current) {
        buttonRef.current.focus();
      } else if (containerRef.current) {
        containerRef.current.focus();
      }
    }
  }, [autoFocus]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-red-800 bg-red-950/60 p-4 text-red-200 shadow-md focus:outline-none"
    >
      <div className="flex items-start space-x-3">
        <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-red-300">{title}</h3>
          <p className="mt-1 text-sm text-red-200/90 leading-relaxed">{message}</p>
          {onRetry && (
            <button
              ref={buttonRef}
              onClick={onRetry}
              disabled={isRetrying}
              className="mt-3 inline-flex items-center gap-1.5 rounded bg-red-800/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-60 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
              {isRetrying ? 'Retrying...' : retryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

