import { Injectable } from '@nestjs/common';
import { buildAiSystemPrompt, type AiInputMessage } from '@whauto/ai';

import { PrismaService } from '../prisma/prisma.service';

export interface AiGenerationContext {
  systemPrompt: string;
  messages: AiInputMessage[];
  /** createdAt de l'ancre — sert aux vérifications d'obsolescence. */
  anchorCreatedAt: Date;
}

/**
 * Construit le contexte envoyé au modèle (ajustement 5) :
 * - ancré sur `contextLastMessageId` ;
 * - UNIQUEMENT la même Conversation ;
 * - messages <= ancre, ordre chronologique ;
 * - bornés par `contextMaxMessages` ;
 * - AUCUNE note interne, aucun coût, aucun secret, aucune donnée d'une autre
 *   Shop (le tenant est déjà garanti par la Conversation).
 */
@Injectable()
export class AiContextService {
  constructor(private readonly prisma: PrismaService) {}

  async build(input: {
    organizationId: string;
    shopId: string;
    conversationId: string;
    contextLastMessageId: string;
    contextMaxMessages: number;
  }): Promise<AiGenerationContext | null> {
    const anchor = await this.prisma.message.findFirst({
      where: { id: input.contextLastMessageId, conversationId: input.conversationId },
      select: { createdAt: true },
    });
    if (!anchor) {
      return null;
    }

    // Derniers messages TEXTE (client ou boutique) jusqu'à l'ancre — jamais de
    // note interne (direction INTERNAL), de média (textContent null) ni de
    // système. On prend les N plus récents puis on rétablit l'ordre chrono.
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: input.conversationId,
        createdAt: { lte: anchor.createdAt },
        direction: { in: ['INBOUND', 'OUTBOUND'] },
        type: 'TEXT',
        textContent: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: input.contextMaxMessages,
      select: { direction: true, textContent: true },
    });

    const messages: AiInputMessage[] = rows
      .reverse()
      .map((row) => ({
        role: row.direction === 'INBOUND' ? ('CUSTOMER' as const) : ('AGENT' as const),
        content: row.textContent ?? '',
      }))
      .filter((message) => message.content.trim() !== '');

    const shop = await this.prisma.shop.findFirst({
      where: { id: input.shopId, organizationId: input.organizationId },
      select: { name: true, currency: true, timezone: true, locale: true },
    });

    const systemPrompt = buildAiSystemPrompt({
      shopName: shop?.name ?? 'la boutique',
      preferredLanguage: shop?.locale,
      currency: shop?.currency,
      timezone: shop?.timezone,
    });

    return { systemPrompt, messages, anchorCreatedAt: anchor.createdAt };
  }
}
