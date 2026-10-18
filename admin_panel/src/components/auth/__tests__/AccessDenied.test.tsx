import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccessDenied } from '../AccessDenied';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthContextValue } from '@/types/auth';

describe('AccessDenied Component', () => {
  const mockRefresh = vi.fn();
  const mockSignOut = vi.fn();

  const defaultMockAuth: AuthContextValue = {
    status: 'ACCESS_DENIED',
    user: {
      email: 'nonadmin@towmitra.test',
      uid: 'user-xyz-123',
    } as any,
    tokenResult: {
      claims: { admin: false },
    } as any,
    isAdmin: false,
    serverProofVerified: false,
    denialReason: 'Your account does not possess the required custom claim admin: true.',
    errorMessage: null,
    isRefreshing: false,
    generation: 1,
    sessionId: null,
    intentId: null,
    bindingId: 1,
    canRenderProtected: false,
    error: null,
    signIn: vi.fn(),
    signOutUser: mockSignOut,
    retryLogout: vi.fn(),
    refreshAuthorization: mockRefresh,
    retryVerification: vi.fn(),
  };

  it('renders user email, UID, and explicit denial reason', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);

    render(<AccessDenied />);

    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.getByText('AUTHORIZATION_REQUIRED')).toBeInTheDocument();
    expect(screen.getByText('nonadmin@towmitra.test')).toBeInTheDocument();
    expect(screen.getByText('UID: user-xyz-123')).toBeInTheDocument();
    expect(
      screen.getByText(/Your account does not possess the required custom claim admin: true/)
    ).toBeInTheDocument();
  });

  it('triggers refreshAuthorization when Refresh button is clicked', async () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);
    const user = userEvent.setup();

    render(<AccessDenied />);

    const refreshButton = screen.getByRole('button', { name: /Refresh Authorization/i });
    await user.click(refreshButton);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('triggers signOutUser when Sign Out button is clicked', async () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);
    const user = userEvent.setup();

    render(<AccessDenied />);

    const signOutButton = screen.getByRole('button', { name: /Sign Out/i });
    await user.click(signOutButton);

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
