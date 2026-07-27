'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { organizationKeys } from '@/features/organizations/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getAccessToken } from '@/lib/api/token-store';

import {
  connectSocket,
  getSocket,
  reconnectDelayMs,
  shouldManuallyReconnect,
} from './socket-client';

interface SocketContextValue {
  /** Incrémenté à chaque (re)connexion abonnée — déclencheur de réconciliation. */
  connectionEpoch: number;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextValue>({ connectionEpoch: 0, isConnected: false });

/**
 * Connecte le socket et gère l'abonnement à la room de l'organisation active.
 * Les événements ne sont jamais la source de vérité : chaque (re)connexion
 * réussie incrémente connectionEpoch, que les hooks de features utilisent
 * pour refetcher (liste des conversations, fil actif) depuis PostgreSQL.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const router = useRouter();
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket = connectSocket();

    const subscribe = () => {
      socket.emit('subscribe:organization', { organizationId }, (ack: { ok: boolean }) => {
        if (ack?.ok) {
          reconnectAttemptRef.current = 0; // Reconnexion réussie : backoff remis à zéro.
          setIsConnected(true);
          // Réconciliation : tout ce qui a pu changer pendant la déconnexion
          // est refetché — les événements sockets n'accélèrent que l'UI.
          setConnectionEpoch((epoch) => epoch + 1);
        }
      });
    };

    /**
     * Filet de sécurité : une coupure décidée par le serveur (expiration du
     * JWT) ne déclenche AUCUNE reconnexion automatique côté socket.io. On la
     * relance donc à la main, avec backoff, et seulement tant qu'un token
     * existe — sinon la session est finie et réessayer est inutile.
     */
    const onDisconnect = (reason: string) => {
      setIsConnected(false);
      if (!shouldManuallyReconnect(reason, getAccessToken() !== null)) {
        return;
      }
      const delay = reconnectDelayMs(reconnectAttemptRef.current);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (getAccessToken() !== null) {
          socket.connect();
        }
      }, delay);
    };

    const onMembershipRevoked = (payload: { organizationId: string }) => {
      if (payload.organizationId === organizationId) {
        // Accès révoqué : revalider la liste des organisations — le provider
        // basculera ou redirigera vers l'onboarding.
        void queryClient.invalidateQueries({ queryKey: organizationKeys.all });
        router.refresh();
      }
    };

    if (socket.connected) {
      subscribe();
    }
    socket.on('connect', subscribe);
    socket.on('disconnect', onDisconnect);
    socket.on('membership.revoked', onMembershipRevoked);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.off('connect', subscribe);
      socket.off('disconnect', onDisconnect);
      socket.off('membership.revoked', onMembershipRevoked);
      setIsConnected(false);
    };
  }, [organizationId, queryClient, router]);

  return (
    <SocketContext.Provider value={{ connectionEpoch, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocketConnection(): SocketContextValue {
  return useContext(SocketContext);
}

export { getSocket };
