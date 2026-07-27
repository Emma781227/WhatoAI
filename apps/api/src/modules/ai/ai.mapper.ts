import { NotFoundError } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  AiConfigurationResponseDto,
  AiRunResponseDto,
  AiSuggestionResponseDto,
} from './dto/ai.dto';

/** Vérifie que la Shop appartient au tenant (404 anti-énumération sinon). */
export async function assertShopInTenant(
  prisma: PrismaService,
  tenant: TenantContext,
  shopId: string,
): Promise<void> {
  const shop = await prisma.shop.findFirst({
    where: { id: shopId, organizationId: tenant.organizationId },
    select: { id: true },
  });
  if (!shop) {
    throw new NotFoundError('Shop not found.');
  }
}

interface ConfigurationRow {
  shopId: string;
  provider: string;
  mode: string;
  model: string | null;
  maxOutputTokens: number;
  contextMaxMessages: number;
  toolMaxRounds: number;
  autoReplyEnabled: boolean;
  autoReplyScheduleMode: string;
  autoReplyMaxPerConversationPerDay: number;
  autoReplyAllowedCategories: string[];
  humanHandoffEnabled: boolean;
  version: number;
}

export function toConfigurationResponse(row: ConfigurationRow): AiConfigurationResponseDto {
  return {
    shopId: row.shopId,
    provider: row.provider,
    mode: row.mode,
    model: row.model,
    maxOutputTokens: row.maxOutputTokens,
    contextMaxMessages: row.contextMaxMessages,
    toolMaxRounds: row.toolMaxRounds,
    autoReplyEnabled: row.autoReplyEnabled,
    autoReplyScheduleMode: row.autoReplyScheduleMode,
    autoReplyMaxPerConversationPerDay: row.autoReplyMaxPerConversationPerDay,
    autoReplyAllowedCategories: row.autoReplyAllowedCategories,
    humanHandoffEnabled: row.humanHandoffEnabled,
    version: row.version,
  };
}

interface SuggestionRow {
  id: string;
  conversationId: string;
  status: string;
  content: string;
  editedContent: string | null;
  version: number;
  contextLastMessageId: string;
  sentMessageId: string | null;
  createdAt: Date;
}

export function toSuggestionResponse(row: SuggestionRow): AiSuggestionResponseDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status,
    // Le contenu affiché est le contenu édité s'il existe, sinon l'original.
    content: row.editedContent ?? row.content,
    version: row.version,
    contextLastMessageId: row.contextLastMessageId,
    sentMessageId: row.sentMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

interface RunRow {
  id: string;
  conversationId: string;
  status: string;
  mode: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  toolRounds: number;
  resolvedModel: string | null;
  errorCode: string | null;
  createdAt: Date;
}

/**
 * DTO run. `includeTechnical=false` (sans ai.viewRuns) masque tokens/modèle/
 * tool rounds/erreur — jamais de prompt ni de payload provider de toute façon.
 */
export function toRunResponse(row: RunRow, includeTechnical: boolean): AiRunResponseDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status,
    mode: row.mode,
    provider: includeTechnical ? row.provider : null,
    inputTokens: includeTechnical ? row.inputTokens : null,
    outputTokens: includeTechnical ? row.outputTokens : null,
    totalTokens: includeTechnical ? row.totalTokens : null,
    toolRounds: includeTechnical ? row.toolRounds : null,
    resolvedModel: includeTechnical ? row.resolvedModel : null,
    errorCode: includeTechnical ? row.errorCode : null,
    createdAt: row.createdAt.toISOString(),
  };
}
