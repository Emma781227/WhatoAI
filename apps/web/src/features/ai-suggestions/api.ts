import { apiRequest } from '@/lib/api/client';

export type AiSuggestionStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'EDITED_AND_ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED';

export interface AiSuggestion {
  id: string;
  conversationId: string;
  status: AiSuggestionStatus;
  content: string | null;
  version: number;
  contextLastMessageId: string;
  sentMessageId: string | null;
  createdAt: string;
}

export interface AiRun {
  id: string;
  conversationId: string;
  status: string;
  mode: string;
  provider: string | null;
  totalTokens: number | null;
  resolvedModel: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface GenerateResult {
  status: string;
  suggestion: AiSuggestion | null;
}

export interface AcceptResult {
  suggestion: AiSuggestion;
  message: { id: string };
}

/** Query keys scoppées par organisation + conversation. */
export const aiKeys = {
  all: (org: string) => ['ai', org] as const,
  suggestions: (org: string, conversationId: string) =>
    [...aiKeys.all(org), 'suggestions', conversationId] as const,
  runs: (org: string, conversationId: string) => [...aiKeys.all(org), 'runs', conversationId] as const,
};

export const aiSuggestionsApi = {
  list(org: string, conversationId: string): Promise<{ items: AiSuggestion[] }> {
    return apiRequest(`/organizations/${org}/conversations/${conversationId}/ai/suggestions`);
  },

  generate(org: string, conversationId: string, forceRegenerate = false): Promise<GenerateResult> {
    return apiRequest(
      `/organizations/${org}/conversations/${conversationId}/ai/suggestions/generate`,
      { method: 'POST', body: { forceRegenerate } },
    );
  },

  accept(
    org: string,
    conversationId: string,
    suggestionId: string,
    input: { content: string; expectedVersion: number; confirmStale?: boolean },
  ): Promise<AcceptResult> {
    return apiRequest(
      `/organizations/${org}/conversations/${conversationId}/ai/suggestions/${suggestionId}/accept`,
      { method: 'POST', body: input },
    );
  },

  reject(
    org: string,
    conversationId: string,
    suggestionId: string,
    input: { expectedVersion: number; reason?: string | null },
  ): Promise<AiSuggestion> {
    return apiRequest(
      `/organizations/${org}/conversations/${conversationId}/ai/suggestions/${suggestionId}/reject`,
      { method: 'POST', body: input },
    );
  },
};
