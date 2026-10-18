import React, { useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Truck, Lock, Mail, AlertCircle, ArrowRight, ShieldCheck, KeyRound } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { EMULATOR_CONFIG } from '@/config/firebase';

export const LoginPage: React.FC = () => {
  const { status, signIn, error, errorMessage: authErrorMessage, retryLogout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // If already authenticated as admin, redirect to target or home
  if (status === 'AUTHORIZED_ADMIN') {
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setErrorMessage('Please enter both email and password.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const outcome = await signIn(email.trim(), password);
      if (outcome === 'SUPERSEDED') {
        // Canceled/superseded login operation; do not navigate or display error
        return;
      }
      if (outcome === 'AUTHORIZED' || outcome === 'DENIED') {
        const destination =
          (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
        navigate(destination);
        return;
      }
      if (outcome === 'ERROR') {
        // Coordinator has transitioned to ERROR and set authErrorMessage/error.
        // Do not navigate, do not overwrite with generic credential error.
        return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'AUTH_OPERATION_CANCELED' || message === 'SUPERSEDED') {
        return;
      }
      if (
        message.includes('auth/invalid-credential') ||
        message.includes('auth/user-not-found') ||
        message.includes('auth/wrong-password')
      ) {
        setErrorMessage('Invalid email or password. Please verify development credentials.');
      } else if (message.includes('auth/network-request-failed')) {
        setErrorMessage(
          'Cannot reach Firebase Auth Emulator. Ensure the emulator is running on port 9099.'
        );
      } else {
        setErrorMessage(`Login failed: ${message}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const fillCredentials = (syntheticEmail: string, syntheticPass: string) => {
    setEmail(syntheticEmail);
    setPassword(syntheticPass);
    setErrorMessage(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        {/* TowMitra Brand Header */}
        <div className="flex justify-center">
          <div className="p-3 bg-gradient-to-br from-orange-500 to-orange-700 rounded-2xl text-white shadow-xl shadow-orange-950/50">
            <Truck className="h-10 w-10" />
          </div>
        </div>
        <h2 className="mt-4 text-center text-2xl font-extrabold tracking-tight text-white">
          TowMitra Admin Console
        </h2>
        <p className="mt-1 text-center text-xs text-slate-400">
          Navi Mumbai Towing Operations & Dispatch Management
        </p>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-slate-900 py-8 px-6 shadow-2xl rounded-2xl border border-slate-800 sm:px-8">
          {/* Emulator Notice */}
          <div className="mb-6 rounded-lg bg-emerald-950/40 border border-emerald-800/60 p-3 text-xs text-emerald-300 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400 flex-shrink-0" />
            <div>
              <p className="font-semibold font-mono">Firebase Emulator Mode Active</p>
              <p className="text-[11px] text-emerald-400/80">Project: {EMULATOR_CONFIG.projectId}</p>
            </div>
          </div>

          {status === 'ERROR' && !errorMessage && (
            <div
              id="auth-error-banner"
              role="alert"
              aria-live="polite"
              className="mb-6 rounded-lg bg-red-950/60 border border-red-800 p-3.5 text-xs text-red-200"
            >
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-red-300">
                      {error?.kind === 'LOGOUT'
                        ? 'Logout Failure'
                        : error?.kind === 'COORDINATION'
                        ? 'Session Storage Failure'
                        : 'Authentication Failure'}
                    </p>
                    <p className="text-[11px] text-red-400/80 mt-0.5">
                      {authErrorMessage || 'Previous operation failed.'}
                    </p>
                  </div>
                </div>
                {error?.kind === 'LOGOUT' && (
                  <button
                    type="button"
                    onClick={() => {
                      Promise.resolve(retryLogout(error?.logoutTarget)).catch(() => {});
                    }}
                    className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-medium flex-shrink-0"
                  >
                    Retry Sign Out
                  </button>
                )}
              </div>
            </div>
          )}

          {errorMessage && (
            <div
              id="login-error"
              role="alert"
              aria-live="polite"
              className="mb-6 rounded-lg bg-red-950/60 border border-red-800 p-3.5 text-xs text-red-200 flex items-start gap-2.5"
            >
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">{errorMessage}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-slate-300">
                Administrator Email
              </label>
              <div className="mt-1 relative rounded-lg shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Mail className="h-4 w-4" />
                </div>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@towmitra.test"
                  aria-invalid={errorMessage ? 'true' : undefined}
                  aria-describedby={errorMessage ? 'login-error' : undefined}
                  className="block w-full pl-9 pr-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-slate-300">
                Password
              </label>
              <div className="mt-1 relative rounded-lg shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  aria-invalid={errorMessage ? 'true' : undefined}
                  aria-describedby={errorMessage ? 'login-error' : undefined}
                  className="block w-full pl-9 pr-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent transition"
                />
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex justify-center items-center gap-2 py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-orange-600 hover:bg-orange-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 focus:ring-offset-slate-900 disabled:opacity-50 transition"
              >
                {isSubmitting ? (
                  <span>Authenticating...</span>
                ) : (
                  <>
                    <span>Sign In to Console</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Synthetic Development Account Quick Helpers */}
          <div className="mt-6 pt-5 border-t border-slate-800">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5 text-orange-400" />
              <span>Development Fixture Accounts</span>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => fillCredentials('admin@towmitra.test', 'AdminPassword123!')}
                className="p-2 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 text-left transition"
              >
                <div className="font-semibold text-slate-200">Admin User</div>
                <div className="text-[10px] text-emerald-400 font-mono">admin: true</div>
                <div className="text-[10px] text-slate-400 truncate">admin@towmitra.test</div>
              </button>

              <button
                type="button"
                onClick={() => fillCredentials('operator@towmitra.test', 'OperatorPassword123!')}
                className="p-2 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 text-left transition"
              >
                <div className="font-semibold text-slate-200">Non-Admin</div>
                <div className="text-[10px] text-amber-400 font-mono">admin: false</div>
                <div className="text-[10px] text-slate-400 truncate">operator@towmitra.test</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
