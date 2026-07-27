import { ForbiddenException, Injectable } from '@nestjs/common';
import { AiConfigurationVersionConflictError } from '@whauto/shared';

import { PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { AiConfigurationResponseDto, UpdateAiConfigurationDto } from './dto/ai.dto';
import { assertShopInTenant, toConfigurationResponse } from './ai.mapper';

/**
 * Configuration IA par Shop. Aucune clé API stockée ni renvoyée. L'activation
 * AUTO_REPLY (mode=AUTO_REPLY ou autoReplyEnabled=true) exige la permission
 * dédiée `ai.enableAutoReply` ET reste sans effet fonctionnel dans cette phase
 * (le worker ne déclenche jamais d'envoi automatique).
 */
@Injectable()
export class AiConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OrganizationAuditService,
  ) {}

  async get(tenant: TenantContext, shopId: string): Promise<AiConfigurationResponseDto> {
    await assertShopInTenant(this.prisma, tenant, shopId);
    const config = await this.ensureConfiguration(tenant, shopId);
    return toConfigurationResponse(config);
  }

  async update(
    tenant: TenantContext,
    shopId: string,
    dto: UpdateAiConfigurationDto,
    context: AuditActionContext,
  ): Promise<AiConfigurationResponseDto> {
    await assertShopInTenant(this.prisma, tenant, shopId);
    await this.ensureConfiguration(tenant, shopId);

    const wantsAutoReply = dto.mode === 'AUTO_REPLY' || dto.autoReplyEnabled === true;
    if (wantsAutoReply && !tenant.permissions.includes(PERMISSIONS.AI_ENABLE_AUTO_REPLY)) {
      throw new ForbiddenException('AUTO_REPLY activation requires ai.enableAutoReply.');
    }

    const data: Record<string, unknown> = {};
    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.mode !== undefined) data.mode = dto.mode;
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.systemPromptOverride !== undefined) data.systemPromptOverride = dto.systemPromptOverride;
    if (dto.maxOutputTokens !== undefined) data.maxOutputTokens = dto.maxOutputTokens;
    if (dto.contextMaxMessages !== undefined) data.contextMaxMessages = dto.contextMaxMessages;
    if (dto.toolMaxRounds !== undefined) data.toolMaxRounds = dto.toolMaxRounds;
    if (dto.humanHandoffEnabled !== undefined) data.humanHandoffEnabled = dto.humanHandoffEnabled;
    if (dto.autoReplyEnabled !== undefined) data.autoReplyEnabled = dto.autoReplyEnabled;
    if (dto.autoReplyScheduleMode !== undefined) data.autoReplyScheduleMode = dto.autoReplyScheduleMode;
    if (dto.autoReplyMaxPerConversationPerDay !== undefined)
      data.autoReplyMaxPerConversationPerDay = dto.autoReplyMaxPerConversationPerDay;
    if (dto.autoReplyAllowedCategories !== undefined)
      data.autoReplyAllowedCategories = dto.autoReplyAllowedCategories;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.aiConfiguration.updateMany({
        where: { shopId, organizationId: tenant.organizationId, version: dto.expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count !== 1) {
        throw new AiConfigurationVersionConflictError();
      }
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'AI_CONFIGURATION_UPDATED',
          actorUserId: tenant.userId,
          // Metadata = NOMS des champs modifiés, jamais leur contenu (systemPrompt).
          metadata: { shopId, fields: Object.keys(data) },
          context,
        },
        tx,
      );
      return tx.aiConfiguration.findFirstOrThrow({
        where: { shopId, organizationId: tenant.organizationId },
      });
    });

    return toConfigurationResponse(updated);
  }

  /** Crée la configuration par défaut (DISABLED) si absente — idempotent. */
  private async ensureConfiguration(tenant: TenantContext, shopId: string) {
    const existing = await this.prisma.aiConfiguration.findFirst({
      where: { shopId, organizationId: tenant.organizationId },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.aiConfiguration.create({
        data: { organizationId: tenant.organizationId, shopId, mode: 'DISABLED' },
      });
    } catch {
      // Course : une autre requête l'a créée.
      return this.prisma.aiConfiguration.findFirstOrThrow({
        where: { shopId, organizationId: tenant.organizationId },
      });
    }
  }
}
