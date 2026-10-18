import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthContextValue } from '@/types/auth';

describe('ProtectedRoute Guard', () => {
  const baseMockAuth: AuthContextValue = {
    status: 'INITIALIZING',
    user: null,
    tokenResult: null,
    isAdmin: false,
    serverProofVerified: false,
    denialReason: null,
    errorMessage: null,
    isRefreshing: false,
    generation: 1,
    sessionId: null,
    intentId: null,
    bindingId: 1,
    canRenderProtected: false,
    error: null,
    signIn: vi.fn(),
    signOutUser: vi.fn(),
    retryLogout: vi.fn(),
    refreshAuthorization: vi.fn(),
    retryVerification: vi.fn(),
  };

  const renderWithRouter = (initialRoute = '/') => {
    return render(
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path="/login" element={<div>Login Page Mock</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div>Protected Dashboard Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  };

  it('renders loading spinner when INITIALIZING', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'INITIALIZING',
    });

    renderWithRouter('/');
    expect(screen.getByText('Restoring admin session...')).toBeInTheDocument();
  });

  it('renders loading spinner when VERIFYING_AUTHORIZATION', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'VERIFYING_AUTHORIZATION',
      user: { email: 'admin@towmitra.test' } as any,
    });

    renderWithRouter('/');
    expect(screen.getByText(/Verifying server-authoritative admin authorization/i)).toBeInTheDocument();
  });

  it('redirects to /login when UNAUTHENTICATED', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'UNAUTHENTICATED',
    });

    renderWithRouter('/');
    expect(screen.getByText('Login Page Mock')).toBeInTheDocument();
  });

  it('renders AccessDenied when status is ACCESS_DENIED', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'ACCESS_DENIED',
      user: { email: 'driver@towmitra.test' } as any,
      denialReason: 'Non-admin user denied.',
    });

    renderWithRouter('/');
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.getByText('Non-admin user denied.')).toBeInTheDocument();
  });

  it('renders ErrorBanner with retry button when status is ERROR', () => {
    const mockRetry = vi.fn();
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'ERROR',
      user: { email: 'admin@towmitra.test' } as any,
      errorMessage: 'Firestore network timeout.',
      retryVerification: mockRetry,
    });

    renderWithRouter('/');
    expect(screen.getByText('Authorization Verification Failure')).toBeInTheDocument();
    expect(screen.getByText('Firestore network timeout.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry Verification/i })).toBeInTheDocument();
  });

  it('renders protected outlet content when AUTHORIZED_ADMIN', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'AUTHORIZED_ADMIN',
      user: { email: 'admin@towmitra.test' } as any,
      isAdmin: true,
      serverProofVerified: true,
      canRenderProtected: true,
    });

    renderWithRouter('/');
    expect(screen.getByText('Protected Dashboard Content')).toBeInTheDocument();
  });

  it('unmounts protected outlet and renders Logout Failure with Retry Sign Out on logout error (D7)', () => {
    const mockRetryLogout = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      ...baseMockAuth,
      status: 'ERROR',
      user: { email: 'admin@towmitra.test' } as any,
      errorMessage: 'Logout failed: Persistence removal failed. Session removal was rejected by authentication provider.',
      error: { kind: 'LOGOUT', owner: 'test-owner' },
      retryLogout: mockRetryLogout,
    });

    renderWithRouter('/');
    expect(screen.queryByText('Protected Dashboard Content')).not.toBeInTheDocument();
    expect(screen.getByText('Logout Failure')).toBeInTheDocument();
    expect(screen.getByText(/Persistence removal failed/i)).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry Sign Out/i });
    expect(retryBtn).toBeInTheDocument();
    retryBtn.click();
    expect(mockRetryLogout).toHaveBeenCalledTimes(1);
  });
});
