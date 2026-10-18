import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardShellPage } from '../DashboardShellPage';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthContextValue } from '@/types/auth';

describe('DashboardShellPage Component', () => {
  const defaultMockAuth: AuthContextValue = {
    status: 'AUTHORIZED_ADMIN',
    user: {
      email: 'admin@towmitra.test',
      uid: 'admin-uid-999',
    } as any,
    tokenResult: {
      authTime: '2026-10-17T02:00:00.000Z',
      claims: { admin: true },
    } as any,
    isAdmin: true,
    serverProofVerified: true,
    denialReason: null,
    errorMessage: null,
    isRefreshing: false,
    generation: 1,
    sessionId: null,
    intentId: null,
    bindingId: 1,
    canRenderProtected: true,
    error: null,
    signIn: vi.fn(),
    signOutUser: vi.fn(),
    retryLogout: vi.fn(),
    refreshAuthorization: vi.fn(),
    retryVerification: vi.fn(),
  };

  it('renders admin identity, server proof status, and five module placeholders', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);

    render(
      <MemoryRouter>
        <DashboardShellPage />
      </MemoryRouter>
    );

    expect(screen.getByText('Operations Console Shell')).toBeInTheDocument();
    expect(screen.getByText('Session Authenticated as Admin')).toBeInTheDocument();
    expect(screen.getByText('admin@towmitra.test')).toBeInTheDocument();
    expect(screen.getByText('dispatch_config/main')).toBeInTheDocument();
    expect(screen.getByText('Verified Server Read')).toBeInTheDocument();

    // Verify all 5 module placeholders are present
    expect(screen.getByText('Driver Verification Queue')).toBeInTheDocument();
    expect(screen.getByText('Live Jobs Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Driver Management')).toBeInTheDocument();
    expect(screen.getByText('Config Editor')).toBeInTheDocument();
    expect(screen.getByText('Phone Booking Pipeline')).toBeInTheDocument();
  });
});
