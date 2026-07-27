'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import { orderKeys, ordersApi } from './api';

const ORDER_EVENTS = [
  'order.created',
  'order.updated',
  'order.status.updated',
  'order.cancelled',
  'order.note.created',
] as const;

/**
 * Commandes liées à une conversation (inbox). Les sockets ne portent que des
 * références + version : toute notification déclenche un refetch autoritaire ;
 * reconnexion = réconciliation via connectionEpoch.
 */
export function useConversationOrders(conversationId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const query = useQuery({
    queryKey: orderKeys.forConversation(organizationId, conversationId ?? 'none'),
    queryFn: () => ordersApi.listForConversation(organizationId, conversationId as string),
    enabled: conversationId !== null,
  });

  useEffect(() => {
    const socket = getSocket();
    if (!socket || conversationId === null) {
      return;
    }
    const handler = (payload: { organizationId: string; conversationId: string }) => {
      if (payload.organizationId !== organizationId) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: orderKeys.all(organizationId) });
    };
    for (const event of ORDER_EVENTS) {
      socket.on(event, handler);
    }
    return () => {
      for (const event of ORDER_EVENTS) {
        socket.off(event, handler);
      }
    };
  }, [conversationId, organizationId, queryClient, connectionEpoch]);

  // Réconciliation à chaque (re)connexion socket.
  useEffect(() => {
    if (connectionEpoch > 0) {
      void queryClient.invalidateQueries({ queryKey: orderKeys.all(organizationId) });
    }
  }, [connectionEpoch, organizationId, queryClient]);

  return query;
}
