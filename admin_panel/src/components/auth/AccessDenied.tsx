import React from 'react';
import { ShieldAlert, RefreshCw, LogOut, Info } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

export const AccessDenied: React.FC = () => {
  const { user, denialReason, refreshAuthorization, signOutUser, isRefreshing, errorMessage } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="max-w-md w-full rounded-xl border border-amber-800/60 bg-slate-900 p-8 shadow-2xl">
        <div className="flex items-center space-x-3 text-amber-500 mb-6">
          <div className="p-3 bg-amber-950/80 rounded-lg border border-amber-700/50">
            <ShieldAlert className="h-8 w-8 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Access Denied</h1>
            <p className="text-xs text-amber-400 font-mono">AUTHORIZATION_REQUIRED</p>
          </div>
        </div>

        <div className="space-y-4 text-sm text-slate-300">
          {errorMessage && (
            <div
              role="alert"
              aria-live="polite"
              className="rounded-lg bg-red-950/60 border border-red-800 p-3.5 text-xs text-red-200"
            >
              {errorMessage}
            </div>
          )}

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Authenticated Account</p>
            <p className="font-mono text-sm text-slate-200 break-all">{user?.email || 'Unknown User'}</p>
            <p className="text-xs text-slate-400 mt-1 font-mono">UID: {user?.uid || 'N/A'}</p>
          </div>

          <div className="rounded-lg bg-amber-950/40 border border-amber-900/50 p-3.5 text-amber-200/90 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-400">Denial Reason</p>
            <p className="text-xs leading-relaxed">
              {denialReason || 'Your authenticated account does not possess the required custom claim "admin: true" or server-authoritative Firestore rules rejected read authorization.'}
            </p>
          </div>

          <div className="rounded-lg bg-slate-950/50 border border-slate-800/80 p-3 text-xs text-slate-400 flex items-start gap-2">
            <Info className="h-4 w-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <p>
              If administrator privileges were just granted via the CLI bootstrap tooling, click <strong>Refresh Authorization</strong> below to force an immediate token refresh.
            </p>
          </div>
        </div>

        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => refreshAuthorization()}
            disabled={isRefreshing}
            className="flex-1 inline-flex justify-center items-center gap-2 rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50 transition"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Checking...' : 'Refresh Authorization'}
          </button>

          <button
            onClick={() => {
              Promise.resolve(signOutUser()).catch(() => {});
            }}
            data-testid="access-denied-sign-out"
            className="inline-flex justify-center items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:ring-offset-slate-900 transition"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};
