'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import { aiKeys, aiSuggestionsApi } from './api';

/** Événements IA (références seules) déclenchant un refetch des suggestions. */
const AI_EVENTS = [
  'ai.run.started',
  'ai.run.completed',
  'ai.run.failed',
  'ai.suggestion.created',
  'ai.handoff.requested',
] as const;

/**
 * Suggestions IA d'une conversation. Le socket n'est jamais la source de
 * vérité : tout événement `ai.*` (payload de références) déclenche un refetch,
 * et chaque (re)connexion réconcilie (connectionEpoch). Les query keys sont
 * scoppées org + conversation — aucune fuite entre conversations/organisations.
 */
export function useAiSuggestions(conversationId: string | null, enabled: boolean) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const queryKey = aiKeys.suggestions(organizationId, conversationId ?? 'none');

  const query = useQuery({
    queryKey,
    queryFn: () => aiSuggestionsApi.list(organizationId, conversationId as string),
    enabled: enabled && conversationId !== null,
  });

  useEffect(() => {
    if (connectionEpoch > 0 && conversationId && enabled) {
      void queryClient.invalidateQueries({ queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEpoch, conversationId, organizationId, enabled]);

  useEffect(() => {
    if (!conversationId || !enabled) {
      return;
    }
    const socket = getSocket();
    const refetch = (payload: { organizationId: string; conversationId: string }) => {
      if (payload.organizationId !== organizationId || payload.conversationId !== conversationId) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey });
    };
    for (const event of AI_EVENTS) {
      socket.on(event, refetch);
    }
    return () => {
      for (const event of AI_EVENTS) {
        socket.off(event, refetch);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, organizationId, enabled]);

  return query;
}

export function useGenerateSuggestion(conversationId: string) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (forceRegenerate: boolean) =>
      aiSuggestionsApi.generate(organizationId, conversationId, forceRegenerate),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: aiKeys.suggestions(organizationId, conversationId),
      });
    },
  });
}

export function useAcceptSuggestion(conversationId: string) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      suggestionId: string;
      content: string;
      expectedVersion: number;
      confirmStale?: boolean;
    }) =>
      aiSuggestionsApi.accept(organizationId, conversationId, input.suggestionId, {
        content: input.content,
        expectedVersion: input.expectedVersion,
        confirmStale: input.confirmStale,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: aiKeys.suggestions(organizationId, conversationId),
      });
    },
  });
}

export function useRejectSuggestion(conversationId: string) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { suggestionId: string; expectedVersion: number; reason?: string }) =>
      aiSuggestionsApi.reject(organizationId, conversationId, input.suggestionId, {
        expectedVersion: input.expectedVersion,
        reason: input.reason ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: aiKeys.suggestions(organizationId, conversationId),
      });
    },
  });
}
