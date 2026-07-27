import { Injectable } from '@nestjs/common';
import { NotFoundError, SOCKET_EVENTS } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { AiAutoReplyStateDto } from './dto/ai.dto';

/**
 * Contrôle de l'auto-réponse AU NIVEAU CONVERSATION (sous-phase C, C4) : pause
 * explicite (un humain reprend la main sans envoyer de message) et reprise
 * (rendre la main à l'IA). Le drapeau `aiAutoReplyPaused` est la source machine
 * qui gate l'auto-envoi côté worker ; `mode` suit pour l'affichage
 * (pause → HUMAN, reprise → AI). Idempotent ; audité ; jamais le contenu.
 */
@Injectable()
export class AiAutoReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OrganizationAuditService,
    private readonly realtime: RealtimeService,
  ) {}

  pause(tenant: TenantContext, conversationId: string, context: AuditActionContext) {
    return this.setPaused(tenant, conversationId, true, context);
  }

  resume(tenant: TenantContext, conversationId: string, context: AuditActionContext) {
    return this.setPaused(tenant, conversationId, false, context);
  }

  private async setPaused(
    tenant: TenantContext,
    conversationId: string,
    paused: boolean,
    context: AuditActionContext,
  ): Promise<AiAutoReplyStateDto> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { id: true, shopId: true, mode: true, aiAutoReplyPaused: true },
    });
    if (!conversation) {
      throw new NotFoundError('Conversation not found.');
    }

    // Idempotent : déjà dans l'état voulu → renvoyer l'état courant, sans audit.
    if (conversation.aiAutoReplyPaused === paused) {
      return {
        conversationId,
        mode: conversation.mode,
        aiAutoReplyPaused: conversation.aiAutoReplyPaused,
      };
    }

    // pause → HUMAN (un humain gère) ; reprise → AI (rendu à l'IA).
    const newMode = paused ? 'HUMAN' : 'AI';
    const applied = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        // Transition conditionnelle : deux appels concurrents → un seul agit.
        where: { id: conversationId, organizationId: tenant.organizationId, aiAutoReplyPaused: !paused },
        data: { aiAutoReplyPaused: paused, mode: newMode },
      });
      if (updated.count !== 1) {
        return false;
      }
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          eventType: paused ? 'AI_AUTO_REPLY_PAUSED' : 'AI_AUTO_REPLY_RESUMED',
          actorUserId: tenant.userId,
          metadata: { conversationId },
          context,
        },
        tx,
      );
      return true;
    });

    if (applied) {
      this.realtime.emitToOrganization(tenant.organizationId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
        organizationId: tenant.organizationId,
        shopId: conversation.shopId,
        conversationId,
      });
    }

    // État réel après coup (couvre une course éventuelle).
    const current = await this.prisma.conversation.findFirstOrThrow({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { mode: true, aiAutoReplyPaused: true },
    });
    return { conversationId, mode: current.mode, aiAutoReplyPaused: current.aiAutoReplyPaused };
  }
}
