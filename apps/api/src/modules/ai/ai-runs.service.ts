import { Injectable } from '@nestjs/common';
import { ConversationNotFoundError } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { toRunResponse } from './ai.mapper';
import type { AiRunResponseDto } from './dto/ai.dto';

@Injectable()
export class AiRunsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs d'une conversation. `includeTechnical` (permission ai.viewRuns)
   * décide si tokens/modèle/tool rounds sont exposés — jamais de prompt ni de
   * payload provider dans tous les cas.
   */
  async list(
    tenant: TenantContext,
    conversationId: string,
    includeTechnical: boolean,
  ): Promise<{ items: AiRunResponseDto[] }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    const rows = await this.prisma.aiRun.findMany({
      where: { organizationId: tenant.organizationId, conversationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { items: rows.map((row) => toRunResponse(row, includeTechnical)) };
  }
}
