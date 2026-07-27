'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import { conversationKeys, conversationsApi, type ListConversationsParams } from './api';

/**
 * Liste infinie des conversations + accélération temps réel.
 * Les événements sockets ne portent que des références : on INVALIDE la liste
 * (refetch PostgreSQL), on ne reconstruit jamais l'état depuis l'événement.
 * connectionEpoch (reconnexion socket) déclenche la même réconciliation.
 */
export function useConversationsList(params: ListConversationsParams) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const query = useInfiniteQuery({
    queryKey: conversationKeys.list(organizationId, params),
    queryFn: ({ pageParam }) => conversationsApi.list(organizationId, params, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Réconciliation à chaque (re)connexion socket — jamais de confiance aveugle
  // dans ce qui a été reçu (ou raté) pendant la coupure.
  useEffect(() => {
    if (connectionEpoch > 0) {
      void queryClient.invalidateQueries({
        queryKey: [...conversationKeys.all(organizationId), 'list'],
      });
    }
  }, [connectionEpoch, organizationId, queryClient]);

  useEffect(() => {
    const socket = getSocket();
    const invalidateList = (payload: { organizationId: string; shopId: string }) => {
      if (payload.organizationId !== organizationId) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: [...conversationKeys.all(organizationId), 'list'],
      });
    };
    const invalidateDetail = (payload: { organizationId: string; conversationId: string }) => {
      if (payload.organizationId !== organizationId) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.detail(organizationId, payload.conversationId),
      });
    };
    const onChanged = (payload: { organizationId: string; shopId: string; conversationId: string }) => {
      invalidateList(payload);
      invalidateDetail(payload);
    };

    socket.on('conversation.created', invalidateList);
    socket.on('conversation.updated', onChanged);
    socket.on('conversation.unread.updated', onChanged);
    return () => {
      socket.off('conversation.created', invalidateList);
      socket.off('conversation.updated', onChanged);
      socket.off('conversation.unread.updated', onChanged);
    };
  }, [organizationId, queryClient]);

  return query;
}

/** Détail d'une conversation, refetché à la reconnexion socket. */
export function useConversation(conversationId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  useEffect(() => {
    if (connectionEpoch > 0 && conversationId) {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.detail(organizationId, conversationId),
      });
    }
  }, [connectionEpoch, conversationId, organizationId, queryClient]);

  return useQuery({
    queryKey: conversationKeys.detail(organizationId, conversationId ?? 'none'),
    queryFn: () => conversationsApi.get(organizationId, conversationId as string),
    enabled: conversationId !== null,
  });
}
