import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderError,
  evaluateAiOutputSemantics,
  parseAiStructuredOutput,
  AI_SYSTEM_PROMPT_VERSION,
  type AiProvider,
  type AiProviderResponse,
  type AiStructuredOutput,
  type AiToolResult,
} from '@whauto/ai';
import { isCustomerServiceWindowOpen, type AiRealtimeEvent, SOCKET_EVENTS } from '@whauto/shared';
import type { AiMode } from '@whauto/database';

import { PrismaService } from '../prisma/prisma.service';
import {
  evaluateAutoReplyGate,
  type AutoReplySuppressionReason,
} from './ai-auto-reply-policy';
import { AiContextService, type AiGenerationContext } from './ai-context.service';
import { AiOutboundSenderService } from './ai-outbound-sender.service';
import { AiProviderFactory } from './ai-provider.factory';
import { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { resolveEffectiveAiMode } from './ai-trigger.service';
import { computeOpenState, type OpeningRange } from './tools/opening-hours';
import { aiToolDefinitions } from './tools/tool-registry';
import { AiToolExecutor } from './tools/tool-executor';
import type { AiToolContext } from './tools/tool-types';

/** Le run a changé d'état sous nos pieds (supersede) : abandon propre. */
class RunSupersededError extends Error {
  constructor() {
    super('AI_RUN_SUPERSEDED');
    this.name = 'RunSupersededError';
  }
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  hasTokens: boolean;
  latencyMs: number;
  toolRounds: number;
  resolvedModel: string | null;
}

type Decision =
  | { kind: 'SUGGESTION'; content: string; confidence: number }
  | { kind: 'HANDOFF'; reason: string }
  | { kind: 'NO_REPLY' }
  | { kind: 'INVALID' };

const ACTIVE_STATUSES = ['RUNNING', 'WAITING_TOOL'] as const;

/**
 * Orchestrateur de génération IA (sous-phase B). SÉPARÉ de AiTriggerService
 * (qui garde les gardes + la création du run). Gère le cycle du run, la boucle
 * d'outils bornée, la double validation (forme + sémantique), la revérification
 * d'obsolescence et la persistance finale (AiSuggestion PENDING ou
 * ConversationHandoff REQUESTED — jamais les deux). N'ENVOIE aucun message
 * WhatsApp et ne crée aucun Message outbound.
 */
@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly contextService: AiContextService,
    private readonly providerFactory: AiProviderFactory,
    private readonly toolExecutor: AiToolExecutor,
    private readonly realtime: AiRealtimeEmitter,
    private readonly outboundSender: AiOutboundSenderService,
  ) {}

  /**
   * Point d'entrée. Idempotent : claim conditionnel QUEUED → RUNNING. Un job
   * rejoué, un run déjà terminé ou déjà pris ailleurs → no-op (aucune seconde
   * suggestion). Cycle : QUEUED → RUNNING → [WAITING_TOOL → RUNNING]* →
   * SUCCEEDED/FAILED/SUPERSEDED.
   */
  async runGeneration(aiRunId: string): Promise<void> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: aiRunId },
      select: {
        id: true,
        organizationId: true,
        shopId: true,
        conversationId: true,
        contextLastMessageId: true,
        provider: true,
        model: true,
        mode: true,
        status: true,
      },
    });
    if (!run) {
      return;
    }

    const claimed = await this.prisma.aiRun.updateMany({
      where: { id: run.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date(), promptVersion: AI_SYSTEM_PROMPT_VERSION },
    });
    if (claimed.count !== 1) {
      return; // Déjà RUNNING/terminal/superseded : rien à faire.
    }
    this.emit(SOCKET_EVENTS.AI_RUN_STARTED, run, { status: 'RUNNING' });

    try {
      await this.generate(run);
    } catch (error) {
      if (error instanceof RunSupersededError) {
        return; // Supersédé pendant le run : la trace SUPERSEDED est déjà posée.
      }
      await this.handleError(run, error);
    }
  }

  private async generate(run: RunRow): Promise<void> {
    const config = await this.prisma.aiConfiguration.findUnique({
      where: { shopId: run.shopId },
      select: { maxOutputTokens: true, contextMaxMessages: true, toolMaxRounds: true },
    });
    const maxOutputTokens =
      config?.maxOutputTokens ?? this.configService.get<number>('AI_MAX_OUTPUT_TOKENS') ?? 300;
    const contextMaxMessages =
      config?.contextMaxMessages ?? this.configService.get<number>('AI_CONTEXT_MAX_MESSAGES') ?? 20;
    const toolMaxRounds =
      config?.toolMaxRounds ?? this.configService.get<number>('AI_TOOL_MAX_ROUNDS') ?? 4;
    const toolTimeoutMs = this.configService.get<number>('AI_REQUEST_TIMEOUT_MS') ?? 30000;

    const context = await this.contextService.build({
      organizationId: run.organizationId,
      shopId: run.shopId,
      conversationId: run.conversationId,
      contextLastMessageId: run.contextLastMessageId,
      contextMaxMessages,
    });
    if (!context) {
      await this.finalizeFailed(run, 'AI_CONTEXT_MISSING');
      return;
    }

    const provider = this.providerFactory.getProvider(run.provider, run.model);
    const usage: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      hasTokens: false,
      latencyMs: 0,
      toolRounds: 0,
      resolvedModel: null,
    };

    const toolCtx: AiToolContext = {
      organizationId: run.organizationId,
      shopId: run.shopId,
      conversationId: run.conversationId,
      contactId: await this.contactIdFor(run.conversationId),
      aiRunId: run.id,
    };

    const loop = await this.runToolLoop(run, provider, context, {
      maxOutputTokens,
      toolMaxRounds,
      toolTimeoutMs,
      toolCtx,
      usage,
    });
    usage.toolRounds = loop.toolRounds;

    // Décision finale (avec un retry contrôlé maximum sur INVALID_OUTPUT).
    const resolution = await this.resolveDecision(run, provider, context, loop, usage, {
      maxOutputTokens,
    });

    if (resolution.kind === 'FAILED') {
      await this.finalizeFailed(run, resolution.errorCode);
      return;
    }
    await this.commitDecision(run, context, resolution.decision, usage, loop.finishReason, loop.usedToolNames);
  }

  /** Boucle d'outils STRICTEMENT séquentielle, bornée par toolMaxRounds. */
  private async runToolLoop(
    run: RunRow,
    provider: AiProvider,
    context: AiGenerationContext,
    opts: {
      maxOutputTokens: number;
      toolMaxRounds: number;
      toolTimeoutMs: number;
      toolCtx: AiToolContext;
      usage: UsageAccumulator;
    },
  ): Promise<{
    response: AiProviderResponse;
    toolRounds: number;
    finishReason: string;
    roundsExceeded: boolean;
    usedToolNames: string[];
  }> {
    const tools = aiToolDefinitions();
    // Noms d'outils réellement appelés — base DÉTERMINISTE de la liste blanche
    // d'auto-envoi (C2). Ordre d'exécution conservé, doublons possibles.
    const usedToolNames: string[] = [];
    let response = await provider.generateSuggestion({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools,
      maxOutputTokens: opts.maxOutputTokens,
    });
    this.accumulate(opts.usage, response);

    let toolRounds = 0;
    let sequence = 0;

    while (response.finishReason === 'TOOL_CALLS' && response.toolCalls.length > 0) {
      // Dépassement : handoff contrôlé, AUCUN appel Gemini supplémentaire.
      if (toolRounds >= opts.toolMaxRounds) {
        return { response, toolRounds, finishReason: 'TOOL_CALLS', roundsExceeded: true, usedToolNames };
      }

      await this.transitionActive(run.id, 'WAITING_TOOL');
      const toolResults: AiToolResult[] = [];
      // SÉQUENTIEL — jamais en parallèle (ajustement 3).
      for (const call of response.toolCalls) {
        usedToolNames.push(call.name);
        const outcome = await this.toolExecutor.execute(opts.toolCtx, call.name, call.arguments, {
          round: toolRounds,
          sequence: sequence++,
          timeoutMs: opts.toolTimeoutMs,
        });
        toolResults.push({ id: call.id, name: call.name, result: outcome.result, isError: outcome.isError });
      }
      await this.transitionActive(run.id, 'RUNNING');
      toolRounds += 1;

      response = await provider.continueWithToolResults({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        previousToolCalls: response.toolCalls,
        toolResults,
      });
      this.accumulate(opts.usage, response);
    }

    return { response, toolRounds, finishReason: response.finishReason, roundsExceeded: false, usedToolNames };
  }

  /** Ordre : provider response → parseAiStructuredOutput → evaluateAiOutputSemantics. */
  private async resolveDecision(
    run: RunRow,
    provider: AiProvider,
    context: AiGenerationContext,
    loop: { response: AiProviderResponse; roundsExceeded: boolean; finishReason: string },
    usage: UsageAccumulator,
    opts: { maxOutputTokens: number },
  ): Promise<{ kind: 'DECIDED'; decision: Decision } | { kind: 'FAILED'; errorCode: string }> {
    if (loop.roundsExceeded) {
      return { kind: 'DECIDED', decision: { kind: 'HANDOFF', reason: 'AI_TOOL_ROUNDS_EXCEEDED' } };
    }

    let response = loop.response;
    let attempt = 0;
    // INVALID_OUTPUT → un retry contrôlé MAXIMUM, sans outils (structured forcé).
    for (;;) {
      const decision = this.decisionFromResponse(response);
      if (decision.kind !== 'INVALID') {
        return { kind: 'DECIDED', decision };
      }
      if (attempt >= 1) {
        return { kind: 'FAILED', errorCode: 'AI_INVALID_OUTPUT' };
      }
      attempt += 1;
      response = await provider.generateSuggestion({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        tools: [],
        maxOutputTokens: opts.maxOutputTokens,
      });
      this.accumulate(usage, response);
    }
  }

  /** Traduit une réponse finale en décision (jamais d'exception qui s'échappe). */
  private decisionFromResponse(response: AiProviderResponse): Decision {
    // Sécurité : handoff contrôlé (ajustement 12).
    if (response.finishReason === 'SAFETY') {
      return { kind: 'HANDOFF', reason: 'AI_SAFETY' };
    }
    if (response.text === null || response.text.trim() === '') {
      return { kind: 'INVALID' };
    }

    let parsed: AiStructuredOutput;
    try {
      parsed = parseAiStructuredOutput(response.text);
    } catch {
      return { kind: 'INVALID' };
    }

    const semantic = evaluateAiOutputSemantics(parsed);
    if (semantic.decision === 'FORCE_HANDOFF') {
      return { kind: 'HANDOFF', reason: semantic.issue ?? 'AI_FORCE_HANDOFF' };
    }
    if (semantic.decision === 'INVALID_OUTPUT') {
      return { kind: 'INVALID' };
    }
    // CONSISTENT.
    if (parsed.action === 'SUGGEST_REPLY') {
      return { kind: 'SUGGESTION', content: parsed.replyText ?? '', confidence: parsed.confidence };
    }
    if (parsed.action === 'HANDOFF') {
      return { kind: 'HANDOFF', reason: parsed.handoffReason ?? 'AI_HANDOFF' };
    }
    return { kind: 'NO_REPLY' };
  }

  /**
   * Commit final SOUS verrou de la Conversation : revérifie l'obsolescence
   * (ajustement 6), finalise le run et crée l'artefact. Un run ne produit
   * JAMAIS à la fois une suggestion PENDING et un handoff ouvert (ajustement 9).
   */
  private async commitDecision(
    run: RunRow,
    context: AiGenerationContext,
    decision: Decision,
    usage: UsageAccumulator,
    finalFinishReason: string,
    usedToolNames: string[],
  ): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${run.conversationId} FOR UPDATE`;

      const obsolete = await this.checkObsolete(tx, run, context.anchorCreatedAt);
      if (obsolete.superseded) {
        await tx.aiRun.updateMany({
          where: { id: run.id, status: { in: [...ACTIVE_STATUSES] } },
          data: { status: 'SUPERSEDED', completedAt: new Date() },
        });
        return { kind: 'SUPERSEDED' as const };
      }

      const finalized = await tx.aiRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          inputTokens: usage.hasTokens ? usage.inputTokens : null,
          outputTokens: usage.hasTokens ? usage.outputTokens : null,
          totalTokens: usage.hasTokens ? usage.totalTokens : null,
          latencyMs: usage.latencyMs,
          toolRounds: usage.toolRounds,
          resolvedModel: usage.resolvedModel ?? run.model,
        },
      });
      if (finalized.count !== 1) {
        return { kind: 'SUPERSEDED' as const }; // Changé sous verrou.
      }

      // Mode effectif au moment du commit (env > config Shop) : c'est lui, pas
      // le mode figé au déclenchement, qui décide de l'auto-envoi.
      const config = await tx.aiConfiguration.findUnique({
        where: { shopId: run.shopId },
        select: {
          mode: true,
          autoReplyEnabled: true,
          autoReplyScheduleMode: true,
          autoReplyMaxPerConversationPerDay: true,
          autoReplyAllowedCategories: true,
        },
      });
      const envMode = this.configService.get<AiMode>('AI_MODE') ?? 'SUGGEST_ONLY';
      const effectiveMode = resolveEffectiveAiMode(envMode, config?.mode ?? null);
      const autoReplyActive = effectiveMode === 'AUTO_REPLY' && (config?.autoReplyEnabled ?? false);

      // Un handoff déjà ouvert (ex. via un outil pendant le run) BLOQUE toute
      // suggestion ET tout auto-envoi (ajustements 9 & 17) : un humain gère déjà.
      if (decision.kind === 'SUGGESTION') {
        if (obsolete.openHandoffId) {
          return { kind: 'NO_SUGGESTION' as const };
        }

        if (autoReplyActive && config) {
          const gate = await this.evaluateAutoReplyInTx(tx, run, context, decision, config, usedToolNames);
          if (gate.action === 'SEND') {
            const created = await this.outboundSender.createAiOutboundInTx(tx, {
              organizationId: run.organizationId,
              aiRunId: run.id,
              conversation: gate.conversation,
              text: decision.content,
              dispatchId: randomUUID(),
            });
            await tx.aiRun.update({
              where: { id: run.id },
              data: { autoReplyDecision: 'SENT' },
              select: { id: true },
            });
            await this.audit(tx, run, 'AI_AUTO_REPLY_SENT', { messageId: created.messageId });
            return {
              kind: 'AUTO_SENT' as const,
              messageId: created.messageId,
              outboxEventId: created.outboxEventId,
            };
          }
          // SUPPRIMÉ : repli en suggestion humaine (l'agent garde le brouillon).
          const suggestion = await tx.aiSuggestion.create({
            data: {
              aiRunId: run.id,
              organizationId: run.organizationId,
              shopId: run.shopId,
              conversationId: run.conversationId,
              content: decision.content,
              status: 'PENDING',
              contextLastMessageId: run.contextLastMessageId,
            },
            select: { id: true },
          });
          await tx.aiRun.update({
            where: { id: run.id },
            data: { autoReplyDecision: 'SUPPRESSED', autoReplySuppressionReason: gate.reason },
            select: { id: true },
          });
          await this.audit(tx, run, 'AI_AUTO_REPLY_SUPPRESSED', { reason: gate.reason });
          return { kind: 'SUGGESTION' as const, suggestionId: suggestion.id };
        }

        // SUGGEST_ONLY (ou AUTO_REPLY non activé) : comportement inchangé.
        const suggestion = await tx.aiSuggestion.create({
          data: {
            aiRunId: run.id,
            organizationId: run.organizationId,
            shopId: run.shopId,
            conversationId: run.conversationId,
            content: decision.content,
            status: 'PENDING',
            contextLastMessageId: run.contextLastMessageId,
          },
          select: { id: true },
        });
        return { kind: 'SUGGESTION' as const, suggestionId: suggestion.id };
      }

      if (decision.kind === 'HANDOFF') {
        // Transfert = reprise humaine : la conversation passe HUMAN et
        // l'auto-réponse est suspendue (jusqu'à une reprise explicite). Sans
        // effet en SUGGEST_ONLY (aucun auto-envoi), mais sémantiquement correct.
        await tx.conversation.update({
          where: { id: run.conversationId },
          data: { mode: 'HUMAN', aiAutoReplyPaused: true },
          select: { id: true },
        });
        // L'IA a choisi le transfert : en AUTO_REPLY on trace la décision ESCALATED.
        if (autoReplyActive) {
          await tx.aiRun.update({
            where: { id: run.id },
            data: { autoReplyDecision: 'ESCALATED' },
            select: { id: true },
          });
        }
        if (obsolete.openHandoffId) {
          if (autoReplyActive) {
            await this.audit(tx, run, 'AI_AUTO_REPLY_ESCALATED', { handoffId: obsolete.openHandoffId });
          }
          return { kind: 'HANDOFF' as const, handoffId: obsolete.openHandoffId };
        }
        const handoff = await tx.conversationHandoff.create({
          data: {
            organizationId: run.organizationId,
            shopId: run.shopId,
            conversationId: run.conversationId,
            aiRunId: run.id,
            status: 'REQUESTED',
            reason: decision.reason.slice(0, 500),
          },
          select: { id: true },
        });
        if (autoReplyActive) {
          await this.audit(tx, run, 'AI_AUTO_REPLY_ESCALATED', { handoffId: handoff.id });
        }
        return { kind: 'HANDOFF' as const, handoffId: handoff.id };
      }

      return { kind: 'NO_REPLY' as const };
    });

    // Émissions APRÈS commit uniquement — références seules.
    if (outcome.kind === 'SUPERSEDED') {
      return;
    }
    this.emit(SOCKET_EVENTS.AI_RUN_COMPLETED, run, { status: 'SUCCEEDED' });
    if (outcome.kind === 'AUTO_SENT') {
      // Publication BullMQ + message.created/conversation.updated (best-effort).
      await this.outboundSender.publishAndEmit(run.organizationId, outcome.messageId, outcome.outboxEventId);
    } else if (outcome.kind === 'SUGGESTION') {
      this.emit(SOCKET_EVENTS.AI_SUGGESTION_CREATED, run, { suggestionId: outcome.suggestionId });
    } else if (outcome.kind === 'HANDOFF') {
      this.emit(SOCKET_EVENTS.AI_HANDOFF_REQUESTED, run, { handoffId: outcome.handoffId });
    }
    this.logger.debug(`Run IA ${run.id} terminé : ${outcome.kind} (finish ${finalFinishReason}).`);
  }

  /**
   * Évalue la porte d'auto-envoi (C2) SOUS le verrou de la conversation : lit la
   * fenêtre 24 h, les horaires (mode hors-ouverture) et les compteurs anti-boucle
   * DANS la transaction, puis applique la politique déterministe. Renvoie aussi
   * la conversation (channelId/contactId) nécessaire à la création du message.
   */
  private async evaluateAutoReplyInTx(
    tx: PrismaTx,
    run: RunRow,
    context: AiGenerationContext,
    decision: { kind: 'SUGGESTION'; content: string; confidence: number },
    config: {
      autoReplyScheduleMode: 'ALWAYS' | 'OUTSIDE_BUSINESS_HOURS';
      autoReplyMaxPerConversationPerDay: number;
      autoReplyAllowedCategories: string[];
    },
    usedToolNames: string[],
  ): Promise<
    | { action: 'SEND'; conversation: { id: string; shopId: string; channelId: string; contactId: string } }
    | { action: 'SUPPRESS'; reason: AutoReplySuppressionReason }
  > {
    const now = new Date();
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: run.conversationId },
      select: {
        id: true,
        shopId: true,
        channelId: true,
        contactId: true,
        customerServiceWindowExpiresAt: true,
        aiAutoReplyPaused: true,
      },
    });

    // Horaires : uniquement nécessaires en mode « hors ouverture ».
    let isOpenNow = false;
    if (config.autoReplyScheduleMode === 'OUTSIDE_BUSINESS_HOURS') {
      const shop = await tx.shop.findUniqueOrThrow({
        where: { id: run.shopId },
        select: {
          timezone: true,
          openingHours: {
            select: { dayOfWeek: true, opensAtMinutes: true, closesAtMinutes: true },
          },
        },
      });
      isOpenNow = computeOpenState(shop.openingHours as OpeningRange[], now, shop.timezone).isOpenNow;
    }

    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [autoRepliesSinceLastInbound, autoRepliesLast24h] = await Promise.all([
      tx.message.count({
        where: {
          conversationId: run.conversationId,
          direction: 'OUTBOUND',
          isAiGenerated: true,
          createdAt: { gt: context.anchorCreatedAt },
        },
      }),
      tx.message.count({
        where: {
          conversationId: run.conversationId,
          direction: 'OUTBOUND',
          isAiGenerated: true,
          createdAt: { gte: dayAgo },
        },
      }),
    ]);

    const gate = evaluateAutoReplyGate({
      conversationPaused: conversation.aiAutoReplyPaused,
      allowedCategories: config.autoReplyAllowedCategories,
      usedToolNames,
      confidence: decision.confidence,
      windowOpen: isCustomerServiceWindowOpen(conversation.customerServiceWindowExpiresAt, now),
      scheduleMode: config.autoReplyScheduleMode,
      isOpenNow,
      autoRepliesSinceLastInbound,
      autoRepliesLast24h,
      maxPerConversationPerDay: config.autoReplyMaxPerConversationPerDay,
    });

    if (gate.action === 'SEND') {
      return {
        action: 'SEND',
        conversation: {
          id: conversation.id,
          shopId: conversation.shopId,
          channelId: conversation.channelId,
          contactId: conversation.contactId,
        },
      };
    }
    return { action: 'SUPPRESS', reason: gate.reason };
  }

  /** Audit métier IA écrit DANS la transaction (jamais le texte du message). */
  private async audit(
    tx: PrismaTx,
    run: RunRow,
    eventType: 'AI_AUTO_REPLY_SENT' | 'AI_AUTO_REPLY_SUPPRESSED' | 'AI_AUTO_REPLY_ESCALATED',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.organizationAuditEvent.create({
      data: {
        organizationId: run.organizationId,
        eventType,
        metadata: { aiRunId: run.id, conversationId: run.conversationId, ...metadata },
      },
      select: { id: true },
    });
  }

  /** Vérifications d'obsolescence (ajustement 6). */
  private async checkObsolete(
    tx: PrismaTx,
    run: RunRow,
    anchorCreatedAt: Date,
  ): Promise<{ superseded: boolean; openHandoffId: string | null }> {
    // Nouveau message client après l'ancre.
    const newerInbound = await tx.message.count({
      where: {
        conversationId: run.conversationId,
        direction: 'INBOUND',
        senderType: 'CUSTOMER',
        createdAt: { gt: anchorCreatedAt },
      },
    });
    // Réponse humaine (sortante) après l'ancre.
    const newerOutbound = await tx.message.count({
      where: {
        conversationId: run.conversationId,
        direction: 'OUTBOUND',
        createdAt: { gt: anchorCreatedAt },
      },
    });
    if (newerInbound > 0 || newerOutbound > 0) {
      return { superseded: true, openHandoffId: null };
    }

    // Mode IA toujours actif ?
    const config = await tx.aiConfiguration.findUnique({
      where: { shopId: run.shopId },
      select: { mode: true },
    });
    const envMode = this.configService.get<AiMode>('AI_MODE') ?? 'SUGGEST_ONLY';
    if (resolveEffectiveAiMode(envMode, config?.mode ?? null) === 'DISABLED') {
      return { superseded: true, openHandoffId: null };
    }

    // Channel toujours connecté ?
    const conversation = await tx.conversation.findUnique({
      where: { id: run.conversationId },
      select: { channel: { select: { status: true } } },
    });
    if (conversation?.channel.status !== 'CONNECTED') {
      return { superseded: true, openHandoffId: null };
    }

    // Handoff déjà ouvert (n'est PAS une supersession — bloque la suggestion).
    const handoff = await tx.conversationHandoff.findFirst({
      where: { conversationId: run.conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
      select: { id: true },
    });
    return { superseded: false, openHandoffId: handoff?.id ?? null };
  }

  /** Transition conditionnelle entre états actifs ; count 0 ⇒ supersédé. */
  private async transitionActive(runId: string, to: 'RUNNING' | 'WAITING_TOOL'): Promise<void> {
    const from = to === 'WAITING_TOOL' ? 'RUNNING' : 'WAITING_TOOL';
    const updated = await this.prisma.aiRun.updateMany({
      where: { id: runId, status: from },
      data: { status: to },
    });
    if (updated.count !== 1) {
      throw new RunSupersededError();
    }
  }

  private async handleError(run: RunRow, error: unknown): Promise<void> {
    if (error instanceof AiProviderError) {
      // RETRYABLE / QUOTA_ERROR : on relâche le run (RUNNING/WAITING_TOOL →
      // QUEUED) et on laisse BullMQ retenter — jamais un run laissé RUNNING.
      if (error.errorClass === 'RETRYABLE' || error.errorClass === 'QUOTA_ERROR') {
        await this.prisma.aiRun.updateMany({
          where: { id: run.id, status: { in: [...ACTIVE_STATUSES] } },
          data: { status: 'QUEUED', startedAt: null },
        });
        throw error; // BullMQ retente (attempts/backoff bornés).
      }
      // CONFIGURATION_ERROR / NON_RETRYABLE / INVALID_OUTPUT : FAILED sans retry long.
      await this.finalizeFailed(run, error.code);
      return;
    }
    // Erreur inattendue : FAILED (jamais laissé RUNNING), sans boucle de retry.
    this.logger.error(`Run IA ${run.id} : erreur inattendue`, error instanceof Error ? error.stack : error);
    await this.finalizeFailed(run, 'AI_INTERNAL_ERROR');
  }

  private async finalizeFailed(run: RunRow, errorCode: string): Promise<void> {
    const failed = await this.prisma.aiRun.updateMany({
      where: { id: run.id, status: { in: [...ACTIVE_STATUSES] } },
      data: { status: 'FAILED', completedAt: new Date(), errorCode },
    });
    if (failed.count === 1) {
      this.emit(SOCKET_EVENTS.AI_RUN_FAILED, run, { status: 'FAILED' });
    }
  }

  private accumulate(usage: UsageAccumulator, response: AiProviderResponse): void {
    if (response.usage.inputTokens !== null || response.usage.outputTokens !== null) {
      usage.hasTokens = true;
    }
    usage.inputTokens += response.usage.inputTokens ?? 0;
    usage.outputTokens += response.usage.outputTokens ?? 0;
    usage.totalTokens += response.usage.totalTokens ?? 0;
    usage.latencyMs += response.latencyMs;
    if (response.modelVersion) {
      usage.resolvedModel = response.modelVersion;
    }
  }

  private async contactIdFor(conversationId: string): Promise<string> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contactId: true },
    });
    return conversation.contactId;
  }

  private emit(event: string, run: RunRow, extra: Partial<AiRealtimeEvent>): void {
    const payload: AiRealtimeEvent = {
      organizationId: run.organizationId,
      shopId: run.shopId,
      conversationId: run.conversationId,
      aiRunId: run.id,
      ...extra,
    };
    this.realtime.emitToOrganization(run.organizationId, event, payload);
  }
}

interface RunRow {
  id: string;
  organizationId: string;
  shopId: string;
  conversationId: string;
  contextLastMessageId: string;
  provider: 'MOCK' | 'GEMINI';
  model: string;
  mode: AiMode;
  status: string;
}

type PrismaTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
