'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  conversationKeys,
  conversationsApi,
  type Conversation,
  type Message,
} from '@/features/conversations/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useAuth } from '@/lib/auth/auth-provider';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import {
  applyStatusPatch,
  buildOptimisticMessage,
  upsertMessage,
  type MessagesCache,
  type StatusPatch,
} from './message-cache';

/**
 * Fil de messages : infinite query (descendant) + événements sockets appliqués
 * via le POINT D'ENTRÉE UNIQUE du cache (upsertMessage/applyStatusPatch) —
 * aucun doublon possible entre réponse HTTP, cache et socket. Reconnexion =
 * refetch complet (le socket n'est jamais la source de vérité).
 */
export function useConversationMessages(conversationId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const queryKey = conversationKeys.messages(organizationId, conversationId ?? 'none');

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      conversationsApi.listMessages(organizationId, conversationId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: conversationId !== null,
  });

  useEffect(() => {
    if (connectionEpoch > 0 && conversationId) {
      void queryClient.invalidateQueries({ queryKey });
    }
    // queryKey est dérivé de organizationId+conversationId, déjà présents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEpoch, conversationId, organizationId, queryClient]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    const socket = getSocket();

    const onMessageCreated = (payload: {
      organizationId: string;
      conversationId: string;
      message: Message;
    }) => {
      if (payload.organizationId !== organizationId || payload.conversationId !== conversationId) {
        return;
      }
      queryClient.setQueryData<MessagesCache>(queryKey, (cache) =>
        upsertMessage(cache, payload.message),
      );
    };

    const onStatusUpdated = (payload: StatusPatch & { organizationId: string; conversationId: string }) => {
      if (payload.organizationId !== organizationId || payload.conversationId !== conversationId) {
        return;
      }
      queryClient.setQueryData<MessagesCache>(queryKey, (cache) =>
        applyStatusPatch(cache, payload),
      );
    };

    socket.on('message.created', onMessageCreated);
    socket.on('message.status.updated', onStatusUpdated);
    return () => {
      socket.off('message.created', onMessageCreated);
      socket.off('message.status.updated', onStatusUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, organizationId, queryClient]);

  return query;
}

/**
 * Envoi optimiste :
 * 1. clientMessageId généré (crypto.randomUUID) ;
 * 2. message PENDING inséré immédiatement dans le cache ;
 * 3. mutation HTTP — la réponse serveur REMPLACE l'entrée (même clientMessageId) ;
 * 4. les statuts arrivent par socket (progression uniquement) ;
 * 5. échec HTTP → l'entrée optimiste passe FAILED avec retpossibilité d'envoi.
 */
export function useSendMessage(conversation: Conversation | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ text, clientMessageId }: { text: string; clientMessageId: string }) => {
      if (!conversation) {
        throw new Error('No active conversation');
      }
      return conversationsApi.sendMessage(organizationId, conversation.id, {
        text,
        clientMessageId,
      });
    },
    onMutate: ({ text, clientMessageId }) => {
      if (!conversation || !user) {
        return;
      }
      const optimistic = buildOptimisticMessage({
        organizationId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        contactId: conversation.contactId,
        clientMessageId,
        text,
        senderUserId: user.id,
        senderFirstName: user.firstName,
        senderLastName: user.lastName,
      });
      queryClient.setQueryData<MessagesCache>(
        conversationKeys.messages(organizationId, conversation.id),
        (cache) => upsertMessage(cache, optimistic),
      );
    },
    onSuccess: (message) => {
      if (!conversation) {
        return;
      }
      // Même point d'entrée que le socket : remplace l'optimiste, jamais de doublon.
      queryClient.setQueryData<MessagesCache>(
        conversationKeys.messages(organizationId, conversation.id),
        (cache) => upsertMessage(cache, message),
      );
    },
    onError: (_error, { clientMessageId }) => {
      if (!conversation) {
        return;
      }
      // L'entrée optimiste passe FAILED : l'utilisateur voit l'échec et peut
      // renvoyer (nouveau clientMessageId) — jamais de doublon silencieux.
      queryClient.setQueryData<MessagesCache>(
        conversationKeys.messages(organizationId, conversation.id),
        (cache) =>
          applyStatusPatch(cache, {
            messageId: `optimistic:${clientMessageId}`,
            clientMessageId,
            status: 'FAILED',
            sentAt: null,
            deliveredAt: null,
            readAt: null,
            failedAt: new Date().toISOString(),
            errorCode: 'SEND_REQUEST_FAILED',
            errorMessage: null,
          }),
      );
    },
  });
}

/** Retry d'un message FAILED persisté côté serveur (endpoint dédié). */
export function useRetryMessage(conversationId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (messageId: string) => {
      if (!conversationId) {
        throw new Error('No active conversation');
      }
      return conversationsApi.retryMessage(organizationId, conversationId, messageId);
    },
    onSuccess: (message) => {
      if (!conversationId) {
        return;
      }
      queryClient.setQueryData<MessagesCache>(
        conversationKeys.messages(organizationId, conversationId),
        (cache) => upsertMessage(cache, message),
      );
    },
  });
}
