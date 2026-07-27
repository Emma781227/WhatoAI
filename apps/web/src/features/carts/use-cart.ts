'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';
import { ApiError } from '@/lib/api/api-error';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import { cartKeys, cartsApi, type Cart } from './api';

const CART_EVENTS = [
  'cart.updated',
  'cart.reservation.updated',
  'checkout.updated',
  'checkout.confirmed',
] as const;

/**
 * Panier de la conversation. Les événements sockets ne portent que des
 * RÉFÉRENCES + version (validé D14) : toute notification déclenche un refetch
 * des données autoritaires ; reconnexion = réconciliation via connectionEpoch.
 * 404 = aucun panier ouvert (état vide, pas une erreur).
 */
export function useCart(conversationId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const query = useQuery<Cart | null>({
    queryKey: cartKeys.detail(organizationId, conversationId ?? 'none'),
    queryFn: async () => {
      try {
        return await cartsApi.get(organizationId, conversationId as string);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null; // aucun panier ouvert
        }
        throw error;
      }
    },
    enabled: conversationId !== null,
  });

  useEffect(() => {
    if (connectionEpoch > 0 && conversationId) {
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
    }
  }, [connectionEpoch, conversationId, organizationId, queryClient]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    const socket = getSocket();
    const onCartEvent = (payload: { organizationId: string; conversationId: string }) => {
      if (payload.organizationId !== organizationId || payload.conversationId !== conversationId) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
    };
    for (const event of CART_EVENTS) {
      socket.on(event, onCartEvent);
    }
    return () => {
      for (const event of CART_EVENTS) {
        socket.off(event, onCartEvent);
      }
    };
  }, [conversationId, organizationId, queryClient]);

  return query;
}
