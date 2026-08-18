import { AI_AUTO_REPLY_CATEGORIES, type AiAutoReplyCategory } from '@whauto/shared';

import { apiRequest } from '@/lib/api/client';

export type AiMode = 'DISABLED' | 'SUGGEST_ONLY' | 'AUTO_REPLY';
export type AiScheduleMode = 'ALWAYS' | 'OUTSIDE_BUSINESS_HOURS';

export { AI_AUTO_REPLY_CATEGORIES };
export type { AiAutoReplyCategory };

export interface AiConfiguration {
  shopId: string;
  provider: string;
  mode: AiMode;
  model: string | null;
  maxOutputTokens: number;
  contextMaxMessages: number;
  toolMaxRounds: number;
  autoReplyEnabled: boolean;
  autoReplyScheduleMode: AiScheduleMode;
  autoReplyMaxPerConversationPerDay: number;
  autoReplyAllowedCategories: string[];
  humanHandoffEnabled: boolean;
  /** Outils WRITE panier de l'assistant (activés par défaut côté serveur). */
  cartToolsEnabled: boolean;
  version: number;
}

export interface UpdateAiConfigurationInput {
  mode?: AiMode;
  autoReplyEnabled?: boolean;
  autoReplyScheduleMode?: AiScheduleMode;
  autoReplyMaxPerConversationPerDay?: number;
  autoReplyAllowedCategories?: string[];
  humanHandoffEnabled?: boolean;
  cartToolsEnabled?: boolean;
  expectedVersion: number;
}

export const aiConfigKeys = {
  all: (org: string) => ['ai-config', org] as const,
  detail: (org: string, shopId: string) => [...aiConfigKeys.all(org), shopId] as const,
};

export const aiConfigApi = {
  get(org: string, shopId: string): Promise<AiConfiguration> {
    return apiRequest(`/organizations/${org}/shops/${shopId}/ai/configuration`);
  },
  update(org: string, shopId: string, input: UpdateAiConfigurationInput): Promise<AiConfiguration> {
    return apiRequest(`/organizations/${org}/shops/${shopId}/ai/configuration`, {
      method: 'PATCH',
      body: input,
    });
  },
};
