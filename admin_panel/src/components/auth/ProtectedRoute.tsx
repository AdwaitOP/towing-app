import React from 'react';
import { Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { AccessDenied } from '@/components/auth/AccessDenied';
import { ErrorBanner } from '@/components/common/ErrorBanner';

export const ProtectedRoute: React.FC = () => {
  const {
    status,
    errorMessage,
    canRenderProtected,
    error,
    retryVerification,
    retryLogout,
    isRefreshing,
  } = useAuth();
  const location = useLocation();

  if (status === 'INITIALIZING') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <LoadingSpinner message="Restoring admin session..." size="lg" />
      </div>
    );
  }

  if (
    status === 'STAGING' ||
    status === 'WAITING_FOR_SESSION' ||
    status === 'COMMITTING' ||
    status === 'SIGNING_OUT' ||
    status === 'VERIFYING_AUTHORIZATION'
  ) {
    let message = 'Verifying server-authoritative admin authorization...';
    if (status === 'STAGING') message = 'Authenticating credentials...';
    if (status === 'WAITING_FOR_SESSION' || status === 'COMMITTING')
      message = 'Preparing secure session...';
    if (status === 'SIGNING_OUT') message = 'Signing out...';

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <LoadingSpinner message={message} size="lg" />
      </div>
    );
  }

  if (status === 'UNAUTHENTICATED') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (status === 'ACCESS_DENIED') {
    return <AccessDenied />;
  }

  if (status === 'ERROR') {
    // Select retry action by typed error kind, not message substring
    const isLogoutFailure = error?.kind === 'LOGOUT';
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
        <div className="max-w-md w-full space-y-4">
          <ErrorBanner
            title={isLogoutFailure ? 'Logout Failure' : 'Authorization Verification Failure'}
            message={
              errorMessage ||
              'An unexpected error occurred while communicating with the Firebase Auth/Firestore emulator.'
            }
            onRetry={
              isLogoutFailure
                ? () => {
                    Promise.resolve(retryLogout(error?.logoutTarget)).catch(() => {});
                  }
                : retryVerification
            }
            retryLabel={isLogoutFailure ? 'Retry Sign Out' : 'Retry Verification'}
            isRetrying={isRefreshing}
          />
          <div className="text-center">
            <Link
              to="/login"
              className="text-sm font-medium text-amber-500 hover:text-amber-400 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-slate-950"
            >
              Sign in with a different account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'AUTHORIZED_ADMIN' && canRenderProtected) {
    return <Outlet />;
  }

  // Fail-closed fallback: never render Outlet unless explicitly authorized with verified proof
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <LoadingSpinner message="Verifying session security..." size="lg" />
    </div>
  );
};
