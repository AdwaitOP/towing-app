import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from '../LoginPage';
import * as AuthContextModule from '@/context/AuthContext';
import type { AuthContextValue } from '@/types/auth';

describe('LoginPage Component', () => {
  const mockSignIn = vi.fn();

  const defaultMockAuth: AuthContextValue = {
    status: 'UNAUTHENTICATED',
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
    signIn: mockSignIn,
    signOutUser: vi.fn(),
    retryLogout: vi.fn(),
    refreshAuthorization: vi.fn(),
    retryVerification: vi.fn(),
  };

  it('renders TowMitra branding, inputs, and emulator mode badge', () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    expect(screen.getByText('TowMitra Admin Console')).toBeInTheDocument();
    expect(screen.getByText('Firebase Emulator Mode Active')).toBeInTheDocument();
    expect(screen.getByLabelText(/Administrator Email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign In to Console/i })).toBeInTheDocument();
  });

  it('fills synthetic admin credentials when clicking the helper button', async () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    const adminHelperBtn = screen.getByRole('button', { name: /Admin User/i });
    await user.click(adminHelperBtn);

    const emailInput = screen.getByLabelText(/Administrator Email/i) as HTMLInputElement;
    const passwordInput = screen.getByLabelText(/Password/i) as HTMLInputElement;

    expect(emailInput.value).toBe('admin@towmitra.test');
    expect(passwordInput.value).toBe('AdminPassword123!');
  });

  it('submits credentials to signIn function on form submit', async () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue(defaultMockAuth);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );

    const emailInput = screen.getByLabelText(/Administrator Email/i);
    const passwordInput = screen.getByLabelText(/Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In to Console/i });

    await user.type(emailInput, 'test@towmitra.test');
    await user.type(passwordInput, 'secretPass123');
    await user.click(submitBtn);

    expect(mockSignIn).toHaveBeenCalledWith('test@towmitra.test', 'secretPass123');
  });
});
