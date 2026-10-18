import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import type { AuthContextValue, AuthSnapshot } from '@/types/auth';
import { getAuthCoordinator, AuthCoordinator } from '@/auth/authCoordinator';

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{
  children: React.ReactNode;
  coordinator?: AuthCoordinator | null;
}> = ({ children, coordinator: customCoordinator }) => {
  const coordinator = useMemo(
    () => customCoordinator || getAuthCoordinator(),
    [customCoordinator]
  );

  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => coordinator.getSnapshot());

  useEffect(() => {
    // Start the coordinator (evaluates initial fence and listeners)
    coordinator.start().catch(() => {});

    // Subscribe to coordinator snapshot changes
    const unsubscribe = coordinator.subscribe(() => {
      setSnapshot(coordinator.getSnapshot());
    });

    return () => {
      unsubscribe();
    };
  }, [coordinator]);

  const contextValue: AuthContextValue = useMemo(
    () => ({
      ...snapshot,
      signIn: (email: string, password: string) => coordinator.login(email, password),
      signOutUser: () => coordinator.logout(),
      retryLogout: (target) => coordinator.retryLogout(target),
      refreshAuthorization: () => coordinator.refreshAuthorization(),
      retryVerification: () => coordinator.retryVerification(),
    }),
    [snapshot, coordinator]
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
