'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { authApi, type AuthUser } from '@/features/auth/api';
import { ApiError } from '@/lib/api/api-error';
import { setUnauthorizedHandler } from '@/lib/api/client';
import {
  RefreshCoordinator,
  sessionFromResponse,
  type AuthSessionData,
} from '@/lib/auth/refresh-coordinator';
import { destroySocket, reconnectWithFreshToken } from '@/lib/socket/socket-client';

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** Applique une session obtenue hors login (register auto-login futur, change-password). */
  applySession: (response: { accessToken: string; user: AuthUser }) => void;
  /** Met à jour l'utilisateur local (ex. après verify-email). */
  setUser: (user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Refresh préventif ~60 s avant l'expiration ; le 401 reste le filet de sécurité. */
const PREVENTIVE_REFRESH_MARGIN_MS = 60_000;
const MIN_PREVENTIVE_DELAY_MS = 5_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [user, setUserState] = useState<AuthUser | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrappedRef = useRef(false);

  const coordinatorRef = useRef<RefreshCoordinator | null>(null);
  coordinatorRef.current ??= new RefreshCoordinator({
    refreshFn: async () => {
      try {
        return sessionFromResponse(await authApi.refresh());
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null; // Session réellement morte.
        }
        throw error; // Erreur réseau/serveur : ne pas conclure à une déconnexion.
      }
    },
  });
  const coordinator = coordinatorRef.current;

  const schedulePreventiveRefresh = useCallback(
    (session: AuthSessionData) => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (session.expiresAt === null) {
        return;
      }
      const delay = Math.max(
        session.expiresAt - Date.now() - PREVENTIVE_REFRESH_MARGIN_MS,
        MIN_PREVENTIVE_DELAY_MS,
      );
      refreshTimerRef.current = setTimeout(() => {
        void coordinator.refresh().catch(() => {
          // Panne transitoire : le prochain 401 déclenchera le refresh de secours.
        });
      }, delay);
    },
    [coordinator],
  );

  const handleSession = useCallback(
    (session: AuthSessionData) => {
      setUserState(session.user);
      setStatus('authenticated');
      schedulePreventiveRefresh(session);
      // Le socket porte le token du handshake : sans nouveau handshake, le
      // serveur le coupera à l'expiration de l'ANCIEN token — et socket.io ne
      // se relève pas d'une coupure serveur. On rejoue donc le handshake dès
      // qu'un token frais est disponible (no-op si aucun socket connecté).
      reconnectWithFreshToken();
    },
    [schedulePreventiveRefresh],
  );

  const handleLoggedOut = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setUserState(null);
    setStatus('unauthenticated');
    // Aucun socket ne doit survivre à la session (token périmé côté serveur).
    destroySocket();
    queryClient.clear();
  }, [queryClient]);

  // Bootstrap UNIQUE : seul l'AuthProvider déclenche le refresh initial.
  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;

    const unsubscribeSession = coordinator.onSession(handleSession);
    const unsubscribeLogout = coordinator.onLogout(handleLoggedOut);

    setUnauthorizedHandler(async () => {
      const session = await coordinator.refresh().catch(() => null);
      if (!session) {
        handleLoggedOut();
        return false;
      }
      handleSession(session);
      return true;
    });

    void coordinator
      .refresh()
      .then((session) => {
        if (session) {
          handleSession(session);
        } else {
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        // API injoignable au chargement : état non authentifié, sans boucle.
        setStatus('unauthenticated');
      });

    return () => {
      unsubscribeSession();
      unsubscribeLogout();
      setUnauthorizedHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const response = await authApi.login(input);
      const session = sessionFromResponse(response);
      coordinator.applyLocalSession(session);
      handleSession(session);
      return response.user;
    },
    [coordinator, handleSession],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      coordinator.broadcastLogout();
      handleLoggedOut();
    }
  }, [coordinator, handleLoggedOut]);

  const applySession = useCallback(
    (response: { accessToken: string; user: AuthUser }) => {
      const session = sessionFromResponse(response);
      coordinator.applyLocalSession(session);
      handleSession(session);
    },
    [coordinator, handleSession],
  );

  const setUser = useCallback((nextUser: AuthUser) => {
    setUserState(nextUser);
  }, []);

  const value = useMemo(
    () => ({ status, user, login, logout, applySession, setUser }),
    [status, user, login, logout, applySession, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth doit être utilisé sous AuthProvider');
  }
  return context;
}
