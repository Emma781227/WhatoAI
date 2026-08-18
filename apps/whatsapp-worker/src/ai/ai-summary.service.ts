import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_SUMMARY_PROMPT_VERSION,
  boundSummary,
  buildConversationSummaryPrompt,
  type AiInputMessage,
  type AiProvider,
  type AiProviderResponse,
} from '@whauto/ai';

import { PrismaService } from '../prisma/prisma.service';

export interface AiSummaryOutcome {
  /** Résumé à injecter dans le contexte (existant réutilisé ou fraîchement produit). */
  content: string | null;
  /** Réponse fournisseur si un appel a EU LIEU — l'appelant l'ajoute à l'usage du run. */
  response: AiProviderResponse | null;
  /** Diagnostic : pourquoi on a (ou non) appelé le modèle. */
  reason: 'DISABLED' | 'TOO_SHORT' | 'REUSED' | 'GENERATED' | 'FAILED';
}

/**
 * Résumé roulant de conversation (CI-G2).
 *
 * Problème résolu : au-delà de la fenêtre de contexte, les faits clés d'une
 * conversation longue (« taille 42 », « livraison à Douala », « budget 20 000 »)
 * disparaissent — l'IA re-pose des questions déjà répondues, et chaque run paie
 * quand même l'historique brut qu'il transporte.
 *
 * Le résumé est un APPEL FACTURÉ, donc traité comme une dépense :
 * - jamais sur une conversation courte (`AI_SUMMARY_MIN_MESSAGES`) ;
 * - régénéré seulement tous les N nouveaux messages
 *   (`AI_SUMMARY_REFRESH_EVERY_MESSAGES`) — sinon on réutilise l'existant ;
 * - quand un résumé existe, on ne renvoie au modèle que les messages APPARUS
 *   DEPUIS son ancre (mise à jour incrémentale), pas toute la conversation ;
 * - ses tokens remontent dans l'usage du run porteur : le coût reste visible au
 *   même endroit que le reste (AiUsageEvent), sans nouveau circuit de
 *   facturation.
 *
 * Un échec de résumé n'échoue JAMAIS le run : on retombe sur le résumé existant
 * (ou sur aucun) et la conversation continue.
 */
@Injectable()
export class AiSummaryService {
  private readonly logger = new Logger(AiSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async ensureSummary(input: {
    organizationId: string;
    shopId: string;
    conversationId: string;
    /** Ancre du run : le résumé ne couvrira jamais au-delà de ce message. */
    contextLastMessageId: string;
    provider: AiProvider;
    providerName: 'MOCK' | 'GEMINI';
    model: string;
    aiRunId: string;
  }): Promise<AiSummaryOutcome> {
    if (this.configService.get<boolean>('AI_SUMMARY_ENABLED') === false) {
      return { content: null, response: null, reason: 'DISABLED' };
    }

    const anchor = await this.prisma.message.findFirst({
      where: { id: input.contextLastMessageId, conversationId: input.conversationId },
      select: { createdAt: true },
    });
    if (!anchor) {
      return { content: null, response: null, reason: 'TOO_SHORT' };
    }

    const existing = await this.prisma.conversationSummary.findUnique({
      where: { conversationId: input.conversationId },
      select: {
        id: true,
        content: true,
        version: true,
        coveredThroughMessage: { select: { createdAt: true } },
      },
    });

    const minMessages = this.configService.get<number>('AI_SUMMARY_MIN_MESSAGES') ?? 20;
    const refreshEvery = this.configService.get<number>('AI_SUMMARY_REFRESH_EVERY_MESSAGES') ?? 10;

    const totalCount = await this.countMessages(input.conversationId, anchor.createdAt, null);
    if (totalCount < minMessages) {
      // Conversation courte : l'historique brut tient, un résumé serait une
      // dépense sans contrepartie.
      return { content: existing?.content ?? null, response: null, reason: 'TOO_SHORT' };
    }

    const previousAnchorAt = existing?.coveredThroughMessage.createdAt ?? null;
    if (existing && previousAnchorAt) {
      const since = await this.countMessages(input.conversationId, anchor.createdAt, previousAnchorAt);
      if (since < refreshEvery) {
        return { content: existing.content, response: null, reason: 'REUSED' };
      }
    }

    try {
      const messages = await this.loadMessages(
        input.conversationId,
        anchor.createdAt,
        // Mise à jour incrémentale : seulement le NOUVEAU depuis l'ancre connue.
        existing ? previousAnchorAt : null,
      );
      if (messages.length === 0) {
        return { content: existing?.content ?? null, response: null, reason: 'REUSED' };
      }

      // Nom de la boutique : lu SEULEMENT ici, quand un appel va réellement
      // avoir lieu (aucune requête sur le chemin fréquent « rien à faire »).
      const shop = await this.prisma.shop.findFirst({
        where: { id: input.shopId, organizationId: input.organizationId },
        select: { name: true },
      });

      const response = await input.provider.summarizeConversation({
        systemPrompt: buildConversationSummaryPrompt({
          shopName: shop?.name ?? 'la boutique',
          previousSummary: existing?.content ?? null,
        }),
        messages,
        previousSummary: existing?.content ?? null,
        maxOutputTokens: this.configService.get<number>('AI_SUMMARY_MAX_OUTPUT_TOKENS') ?? 250,
      });

      const text = response.text?.trim();
      if (!text) {
        // Réponse vide : on garde l'ancien résumé, l'appel est quand même
        // compté (il a bien consommé des tokens).
        return { content: existing?.content ?? null, response, reason: 'FAILED' };
      }

      const content = boundSummary(text);
      await this.persist({
        organizationId: input.organizationId,
        shopId: input.shopId,
        conversationId: input.conversationId,
        contextLastMessageId: input.contextLastMessageId,
        content,
        coveredMessageCount: totalCount,
        providerName: input.providerName,
        model: input.model,
        aiRunId: input.aiRunId,
      });

      return { content, response, reason: 'GENERATED' };
    } catch (error) {
      // Un résumé raté ne casse jamais la conversation (aucun contenu loggé).
      this.logger.warn(
        `Résumé de conversation ${input.conversationId} en échec : ${
          error instanceof Error ? error.name : 'inconnu'
        }`,
      );
      return { content: existing?.content ?? null, response: null, reason: 'FAILED' };
    }
  }

  /** Messages TEXTE de la conversation jusqu'à l'ancre (option : après `after`). */
  private countMessages(
    conversationId: string,
    anchorAt: Date,
    after: Date | null,
  ): Promise<number> {
    return this.prisma.message.count({
      where: {
        conversationId,
        createdAt: after ? { gt: after, lte: anchorAt } : { lte: anchorAt },
        direction: { in: ['INBOUND', 'OUTBOUND'] },
        type: 'TEXT',
        textContent: { not: null },
      },
    });
  }

  private async loadMessages(
    conversationId: string,
    anchorAt: Date,
    after: Date | null,
  ): Promise<AiInputMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        createdAt: after ? { gt: after, lte: anchorAt } : { lte: anchorAt },
        direction: { in: ['INBOUND', 'OUTBOUND'] },
        type: 'TEXT',
        textContent: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: this.configService.get<number>('AI_SUMMARY_MAX_INPUT_MESSAGES') ?? 40,
      select: { direction: true, textContent: true },
    });
    return rows
      .reverse()
      .map((row) => ({
        role: row.direction === 'INBOUND' ? ('CUSTOMER' as const) : ('AGENT' as const),
        content: row.textContent ?? '',
      }))
      .filter((message) => message.content.trim() !== '');
  }

  /**
   * Un seul résumé vivant par conversation (`conversationId @unique`) : on
   * remplace, on n'empile pas. L'ancre avance TOUJOURS avec le contenu — un
   * résumé ne doit jamais prétendre couvrir plus que ce qu'il a vu.
   */
  private async persist(input: {
    organizationId: string;
    shopId: string;
    conversationId: string;
    contextLastMessageId: string;
    content: string;
    coveredMessageCount: number;
    providerName: 'MOCK' | 'GEMINI';
    model: string;
    aiRunId: string;
  }): Promise<void> {
    const common = {
      content: input.content,
      coveredThroughMessageId: input.contextLastMessageId,
      coveredMessageCount: input.coveredMessageCount,
      provider: input.providerName,
      model: input.model,
      promptVersion: AI_SUMMARY_PROMPT_VERSION,
      generatedByAiRunId: input.aiRunId,
    };
    await this.prisma.conversationSummary.upsert({
      where: { conversationId: input.conversationId },
      create: {
        organizationId: input.organizationId,
        shopId: input.shopId,
        conversationId: input.conversationId,
        ...common,
      },
      update: { ...common, version: { increment: 1 } },
    });
  }
}
