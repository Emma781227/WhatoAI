import { Injectable, Logger } from '@nestjs/common';
import { assembleContext, buildAiSystemPrompt, type AiInputMessage } from '@whauto/ai';

import { PrismaService } from '../prisma/prisma.service';
import { buildOpeningHoursSummary } from './tools/opening-hours';

export interface AiGenerationContext {
  systemPrompt: string;
  messages: AiInputMessage[];
  /** createdAt de l'ancre — sert aux vérifications d'obsolescence. */
  anchorCreatedAt: Date;
  /** Diagnostic d'assemblage (CI-G1) — jamais envoyé au modèle. */
  budget: {
    estimatedTokens: number;
    droppedMessageCount: number;
    droppedSummary: boolean;
    droppedBusinessRules: boolean;
  };
}

/**
 * Construit le contexte envoyé au modèle (ajustement 5, étendu CI-G1) :
 * - ancré sur `contextLastMessageId` ;
 * - UNIQUEMENT la même Conversation ;
 * - messages <= ancre, ordre chronologique ;
 * - bornés par `contextMaxMessages` PUIS par un budget de TOKENS estimés ;
 * - AUCUNE note interne, aucun coût, aucun secret, aucune donnée d'une autre
 *   Shop (le tenant est déjà garanti par la Conversation).
 *
 * CI-G1 ajoute deux données statiques qui coûtaient auparavant un tour d'outil
 * (ou n'arrivaient jamais) : le résumé des HORAIRES et les RÈGLES de la boutique
 * (`AiConfiguration.systemPromptOverride`, jusqu'ici stocké mais jamais lu).
 */
@Injectable()
export class AiContextService {
  private readonly logger = new Logger(AiContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  async build(input: {
    organizationId: string;
    shopId: string;
    conversationId: string;
    contextLastMessageId: string;
    contextMaxMessages: number;
    /** Outils WRITE panier exposés à ce run — les règles du prompt en dépendent. */
    cartToolsEnabled?: boolean;
    /**
     * Règles commerciales de la Shop (`AiConfiguration.systemPromptOverride`).
     * Traitées comme un COMPLÉMENT borné, jamais comme un remplacement du
     * prompt : un commerçant ne doit pas pouvoir supprimer les règles de
     * sécurité (pas d'invention de prix, pas de paiement, transfert humain).
     */
    businessRules?: string | null;
    /**
     * Résumé roulant de la conversation (CI-G2). Il REMPLACE l'historique
     * ancien : il est plus prioritaire que les vieux messages dans le budget.
     */
    conversationSummary?: string | null;
    /** Budget d'entrée en tokens estimés (<= 0 = aucun budget). */
    contextTokenBudget?: number;
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
      select: {
        name: true,
        currency: true,
        timezone: true,
        locale: true,
        openingHours: { select: { dayOfWeek: true, opensAtMinutes: true, closesAtMinutes: true } },
      },
    });
    const openingHoursSummary = shop ? buildOpeningHoursSummary(shop.openingHours) : null;

    // Assemblage sous budget : les faits boutique sont incompressibles, puis les
    // règles, puis (CI-G2) le résumé, puis l'historique du plus ancien au plus
    // récent — le déclencheur du run n'est jamais sacrifié.
    const assembly = assembleContext(
      {
        shopFacts: [shop?.currency, shop?.timezone, openingHoursSummary].filter(
          (fact): fact is string => typeof fact === 'string' && fact.length > 0,
        ),
        businessRules: input.businessRules ?? null,
        conversationSummary: input.conversationSummary ?? null,
        messages,
      },
      input.contextTokenBudget ?? 0,
    );

    if (assembly.droppedMessageCount > 0 || assembly.droppedBusinessRules) {
      // Une troncature n'est JAMAIS silencieuse (aucun contenu loggé).
      this.logger.debug(
        `Contexte tronqué (conversation ${input.conversationId}) : ` +
          `${assembly.droppedMessageCount} message(s) retiré(s), ` +
          `règles=${assembly.droppedBusinessRules ? 'retirées' : 'gardées'}, ` +
          `~${assembly.estimatedTokens} tokens retenus.`,
      );
    }

    const systemPrompt = buildAiSystemPrompt({
      shopName: shop?.name ?? 'la boutique',
      preferredLanguage: shop?.locale,
      currency: shop?.currency,
      timezone: shop?.timezone,
      openingHoursSummary: openingHoursSummary ?? undefined,
      businessRules: assembly.businessRules ?? undefined,
      conversationSummary: assembly.conversationSummary,
      cartToolsEnabled: input.cartToolsEnabled ?? false,
    });

    return {
      systemPrompt,
      messages: assembly.messages,
      anchorCreatedAt: anchor.createdAt,
      budget: {
        estimatedTokens: assembly.estimatedTokens,
        droppedMessageCount: assembly.droppedMessageCount,
        droppedSummary: assembly.droppedSummary,
        droppedBusinessRules: assembly.droppedBusinessRules,
      },
    };
  }
}
