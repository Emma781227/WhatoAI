import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type AiMode, type AiProviderType, Prisma } from '@whauto/database';
import { SOCKET_EVENTS, type AiProcessMessageJobData } from '@whauto/shared';
import { MAX_CREDITS_PER_AI_RUN } from '@whauto/wallet';

import { PrismaService } from '../prisma/prisma.service';
import { WalletReservationService } from '../wallet/wallet-reservation.service';
import { AiRealtimeEmitter } from './ai-realtime-emitter.service';

/**
 * Décide, pour UN message déclencheur, s'il faut créer un AiRun — et le crée.
 *
 * Toutes les gardes sont REJOUÉES ici (ajustement 1) : l'InboundProcessor ne
 * fait que planifier, la vérité est ré-établie au moment de l'exécution, en
 * base, éventuellement après plusieurs secondes de debounce pendant lesquelles
 * l'état a pu changer (handoff ouvert, IA désactivée, réponse humaine…).
 */

export type AiTriggerOutcome =
  | 'RUN_CREATED'
  | 'SUPERSEDED_AND_CREATED'
  | 'ALREADY_RUN' // idempotent : un run logique existe déjà pour ce déclencheur
  | 'HANDOFF_SKIPPED' // handoff ouvert → run SKIPPED tracé, jamais de génération
  | 'SKIPPED_GLOBAL_DISABLED'
  | 'SKIPPED_SHOP_DISABLED'
  | 'SKIPPED_MESSAGE_GONE'
  | 'SKIPPED_NOT_ELIGIBLE'
  | 'SKIPPED_UNSUPPORTED_TYPE'
  | 'SKIPPED_TENANT_MISMATCH'
  | 'SKIPPED_CHANNEL_NOT_CONNECTED'
  | 'SKIPPED_MISCONFIGURED'
  // Crédits (groupe 4) : le run est tracé SKIPPED, JAMAIS de génération/Gemini.
  | 'SKIPPED_INSUFFICIENT_CREDITS'
  | 'SKIPPED_WALLET_SUSPENDED'
  | 'SKIPPED_WALLET_CLOSED';

export interface AiTriggerResult {
  outcome: AiTriggerOutcome;
  runId: string | null;
  supersededRunId: string | null;
}

/**
 * Résolution du mode effectif (ajustement 2) :
 * 1. `AI_MODE=DISABLED` (env) est un coupe-circuit GLOBAL ;
 * 2. sinon `AiConfiguration.mode` fait autorité SI la ligne existe ;
 * 3. sinon `AI_MODE` (env) sert de défaut.
 */
export function resolveEffectiveAiMode(envMode: AiMode, configMode: AiMode | null): AiMode {
  if (envMode === 'DISABLED') {
    return 'DISABLED';
  }
  return configMode ?? envMode;
}

const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_TOOL'] as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AiTriggerService {
  private readonly logger = new Logger(AiTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly walletReservation: WalletReservationService,
    private readonly realtimeEmitter: AiRealtimeEmitter,
  ) {}

  async processTrigger(data: AiProcessMessageJobData): Promise<AiTriggerResult> {
    const skip = (outcome: AiTriggerOutcome): AiTriggerResult => ({
      outcome,
      runId: null,
      supersededRunId: null,
    });

    // 1. Coupe-circuit GLOBAL — avant toute lecture métier.
    const envMode = this.configService.get<AiMode>('AI_MODE') ?? 'SUGGEST_ONLY';
    if (envMode === 'DISABLED') {
      return skip('SKIPPED_GLOBAL_DISABLED');
    }

    // 2. Message présent + éligible + cohérence tenant/Shop/Conversation/Channel.
    const message = await this.prisma.message.findUnique({
      where: { id: data.triggerMessageId },
      select: {
        id: true,
        organizationId: true,
        shopId: true,
        conversationId: true,
        channelId: true,
        direction: true,
        senderType: true,
        type: true,
        channel: { select: { status: true } },
      },
    });
    if (!message) {
      return skip('SKIPPED_MESSAGE_GONE');
    }
    if (message.direction !== 'INBOUND' || message.senderType !== 'CUSTOMER') {
      return skip('SKIPPED_NOT_ELIGIBLE');
    }
    // Seul TEXT est réellement supporté (ajustement 3) — jamais de run média.
    if (message.type !== 'TEXT') {
      return skip('SKIPPED_UNSUPPORTED_TYPE');
    }
    if (
      message.organizationId !== data.organizationId ||
      message.shopId !== data.shopId ||
      message.conversationId !== data.conversationId ||
      message.channelId !== data.channelId
    ) {
      return skip('SKIPPED_TENANT_MISMATCH');
    }
    if (message.channel.status !== 'CONNECTED') {
      return skip('SKIPPED_CHANNEL_NOT_CONNECTED');
    }

    // 3. Configuration par Shop → mode effectif.
    const config = await this.prisma.aiConfiguration.findUnique({
      where: { shopId: data.shopId },
      select: { provider: true, mode: true, model: true },
    });
    const effectiveMode = resolveEffectiveAiMode(envMode, config?.mode ?? null);
    if (effectiveMode === 'DISABLED') {
      return skip('SKIPPED_SHOP_DISABLED');
    }

    // 4. Provider + modèle (aucun nom de modèle en dur — env ou config).
    const provider: AiProviderType =
      config?.provider ?? this.configService.get<AiProviderType>('AI_PROVIDER') ?? 'MOCK';
    const model =
      config?.model ??
      this.configService.get<string>('GEMINI_MODEL') ??
      (provider === 'MOCK' ? 'mock-model' : null);
    if (model === null) {
      // GEMINI sans modèle configuré : on ne devine jamais un nom de modèle.
      this.logger.warn(`Modèle IA absent pour la Shop ${data.shopId} (provider ${provider}).`);
      return skip('SKIPPED_MISCONFIGURED');
    }

    // 5. Handoff ouvert → run SKIPPED tracé (ajustement 9), jamais de génération.
    const openHandoff = await this.prisma.conversationHandoff.findFirst({
      where: { conversationId: data.conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
      select: { id: true },
    });
    if (openHandoff) {
      const runId = await this.createSkippedRun(data, provider, model, effectiveMode);
      return { outcome: 'HANDOFF_SKIPPED', runId, supersededRunId: null };
    }

    // 6. Création (+ supersede éventuel) SOUS verrou de la Conversation.
    return this.createRunUnderLock(data, provider, model, effectiveMode);
  }

  /**
   * Crée un run terminal SKIPPED (handoff) : consomme le déclencheur
   * (triggerMessageId unique) donc bloque toute reprise, et laisse une trace
   * avec un code interne filtré — jamais de détail sensible.
   */
  private async createSkippedRun(
    data: AiProcessMessageJobData,
    provider: AiProviderType,
    model: string,
    mode: AiMode,
  ): Promise<string | null> {
    try {
      const run = await this.prisma.aiRun.create({
        data: {
          organizationId: data.organizationId,
          shopId: data.shopId,
          conversationId: data.conversationId,
          triggerMessageId: data.triggerMessageId,
          contextLastMessageId: data.triggerMessageId,
          provider,
          model,
          mode,
          status: 'SKIPPED',
          errorCode: 'AI_BLOCKED_BY_HANDOFF',
          completedAt: new Date(),
        },
        select: { id: true },
      });
      return run.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null; // Un run existe déjà pour ce déclencheur : no-op idempotent.
      }
      throw error;
    }
  }

  /**
   * Crée le run SOUS l'ordre de verrou FIXE Conversation → Wallet, et RÉSERVE
   * atomiquement `MAX_CREDITS_PER_AI_RUN` avant tout appel Gemini (groupe 4).
   * Dans UNE transaction : verrou Conversation ; idempotence trigger ; supersede
   * + libération de la réservation du run antérieur ; verrou Wallet ; contrôle du
   * disponible/statut ; création AiRun (QUEUED si réservé, SKIPPED sinon) ;
   * WalletTransaction RESERVE (balance inchangée, reserved +3) ; AiUsageEvent.
   * L'émission temps réel a lieu APRÈS commit (best-effort, jamais de rollback).
   */
  private async createRunUnderLock(
    data: AiProcessMessageJobData,
    provider: AiProviderType,
    model: string,
    mode: AiMode,
  ): Promise<AiTriggerResult> {
    // Provisioning idempotent HORS transaction (un P2002 EN tx avorterait tout).
    const walletId = await this.walletReservation.ensureWalletId(data.organizationId);

    try {
      const decision = await this.prisma.$transaction(async (tx) => {
        // Verrou 1 — Conversation : sérialise supersede/création par conversation.
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${data.conversationId} FOR UPDATE`;

        // Idempotence : un run existe déjà pour CE déclencheur → aucun mouvement.
        const existing = await tx.aiRun.findUnique({
          where: { triggerMessageId: data.triggerMessageId },
          select: { id: true },
        });
        if (existing) {
          return {
            outcome: 'ALREADY_RUN' as AiTriggerOutcome,
            runId: existing.id,
            supersededRunId: null,
            emit: null as WalletEmit,
          };
        }

        // Run actif d'un déclencheur ANTÉRIEUR → sera SUPERSEDED ; sa réservation
        // est libérée AVANT d'évaluer le disponible du nouveau run (les crédits
        // rendus peuvent le rendre réservable). Libération strictement idempotente.
        const active = await tx.aiRun.findFirst({
          where: {
            conversationId: data.conversationId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: { id: true },
        });
        if (active) {
          // Sort le run antérieur de l'ensemble ACTIF AVANT de créer le nouveau
          // (l'index partiel `ai_runs_one_active_per_conversation` interdit deux
          // runs actifs) ; `supersededByRunId` est posé après création. Transition
          // conditionnelle = GATE anti-concurrence.
          const superseded = await tx.aiRun.updateMany({
            where: { id: active.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            data: { status: 'SUPERSEDED', completedAt: new Date() },
          });
          if (superseded.count === 1) {
            await tx.aiSuggestion.updateMany({
              where: { aiRunId: active.id, status: 'PENDING' },
              data: { status: 'EXPIRED' },
            });
            await this.walletReservation.releaseRunReservationInTx(tx, {
              organizationId: data.organizationId,
              aiRunId: active.id,
            });
          }
        }
        const supersededRunId = active?.id ?? null;

        // Verrou 2 — Wallet (après Conversation) : sérialise l'accès
        // cross-conversation au Wallet de l'organisation. Le disponible est lu
        // APRÈS la libération éventuelle.
        const wallet = await this.walletReservation.lockAndReadWallet(
          tx,
          walletId,
          data.organizationId,
        );

        // Éligibilité Wallet du NOUVEAU run — distingue statut et solde.
        const skip = resolveWalletSkip(wallet.status, wallet.availableCredits);

        if (skip) {
          const run = await tx.aiRun.create({
            data: {
              organizationId: data.organizationId,
              shopId: data.shopId,
              conversationId: data.conversationId,
              triggerMessageId: data.triggerMessageId,
              contextLastMessageId: data.triggerMessageId,
              provider,
              model,
              requestedModel: model,
              mode,
              status: 'SKIPPED',
              errorCode: skip.code,
              completedAt: new Date(),
            },
            select: { id: true },
          });
          if (active) {
            await tx.aiRun.update({
              where: { id: active.id },
              data: { supersededByRunId: run.id },
              select: { id: true },
            });
          }
          // AiUsageEvent SKIPPED à 0 crédit : conserve le 1:1 avec le run.
          await this.walletReservation.recordSkippedForRunInTx(tx, {
            organizationId: data.organizationId,
            shopId: data.shopId,
            walletId,
            aiRunId: run.id,
            provider,
            requestedModel: model,
            reasonCode: skip.code,
          });
          return {
            outcome: skip.outcome,
            runId: run.id,
            supersededRunId,
            // wallet.insufficient uniquement pour un solde trop bas.
            emit: skip.code === 'INSUFFICIENT_CREDITS' ? ('INSUFFICIENT' as WalletEmit) : null,
          };
        }

        // Réservation + run QUEUED (prêt pour la génération).
        const run = await tx.aiRun.create({
          data: {
            organizationId: data.organizationId,
            shopId: data.shopId,
            conversationId: data.conversationId,
            triggerMessageId: data.triggerMessageId,
            contextLastMessageId: data.triggerMessageId,
            provider,
            model,
            // Modèle demandé (config/env) figé au run ; resolvedModel sera
            // rempli à la génération avec le modèle réellement servi.
            requestedModel: model,
            mode,
            status: 'QUEUED',
          },
          select: { id: true },
        });
        if (active) {
          await tx.aiRun.update({
            where: { id: active.id },
            data: { supersededByRunId: run.id },
            select: { id: true },
          });
        }
        await this.walletReservation.reserveForRunInTx(tx, {
          organizationId: data.organizationId,
          shopId: data.shopId,
          walletId,
          aiRunId: run.id,
          provider,
          requestedModel: model,
        });
        return {
          outcome: (active ? 'SUPERSEDED_AND_CREATED' : 'RUN_CREATED') as AiTriggerOutcome,
          runId: run.id,
          supersededRunId,
          emit: 'BALANCE' as WalletEmit,
        };
      });

      // Émission temps réel APRÈS commit — jamais dans la transaction.
      await this.emitWalletAfterCommit(data, walletId, decision.emit);

      return {
        outcome: decision.outcome,
        runId: decision.runId,
        supersededRunId: decision.supersededRunId,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Course perdue (triggerMessageId ou index « un actif par conversation ») :
        // un autre worker a créé le run — no-op idempotent, jamais une erreur.
        // Aucune réservation n'a abouti ici (P2002 avorte la transaction).
        const existing = await this.prisma.aiRun.findUnique({
          where: { triggerMessageId: data.triggerMessageId },
          select: { id: true },
        });
        return { outcome: 'ALREADY_RUN', runId: existing?.id ?? null, supersededRunId: null };
      }
      throw error;
    }
  }

  /**
   * Publie le solde agrégé du Wallet APRÈS commit (best-effort). Lit l'état
   * committé, calcule `aiAvailable` (dérivé) et n'émet aucun secret ni détail
   * Gemini. Une émission échouée ne fait jamais échouer un run.
   */
  private async emitWalletAfterCommit(
    data: AiProcessMessageJobData,
    walletId: string,
    emit: WalletEmit,
  ): Promise<void> {
    if (!emit) {
      return;
    }
    // Best-effort STRICT : la réservation est déjà committée ; une lecture ou une
    // émission en échec (Redis KO) ne doit JAMAIS faire échouer le run — le
    // recovery/refetch réconcilie. Aucune libération ici.
    try {
      const payload = await this.walletReservation.buildBalanceEvent(data.organizationId, walletId, {
        conversationId: data.conversationId,
        ...(emit === 'INSUFFICIENT' ? { requiredCredits: MAX_CREDITS_PER_AI_RUN } : {}),
      });
      if (!payload) {
        return;
      }
      const event =
        emit === 'INSUFFICIENT'
          ? SOCKET_EVENTS.WALLET_INSUFFICIENT
          : SOCKET_EVENTS.WALLET_BALANCE_UPDATED;
      this.realtimeEmitter.emitToOrganization(data.organizationId, event, payload);
    } catch (error) {
      this.logger.warn(
        `Émission Wallet post-commit échouée (réservation conservée) : ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Directive d'émission temps réel post-commit (aucune = pas d'émission). */
type WalletEmit = 'BALANCE' | 'INSUFFICIENT' | null;

/**
 * Décide si un run doit être SKIPPÉ pour raison Wallet (statut ou solde). CLOSED
 * et SUSPENDED priment sur le solde ; le solde insuffisant est distinct
 * (`INSUFFICIENT_CREDITS`). Retourne `null` si la réservation est autorisée.
 */
function resolveWalletSkip(
  status: string,
  available: number,
): { code: string; outcome: AiTriggerOutcome } | null {
  if (status === 'CLOSED') {
    return { code: 'WALLET_CLOSED', outcome: 'SKIPPED_WALLET_CLOSED' };
  }
  if (status !== 'ACTIVE') {
    return { code: 'WALLET_SUSPENDED', outcome: 'SKIPPED_WALLET_SUSPENDED' };
  }
  if (available < MAX_CREDITS_PER_AI_RUN) {
    return { code: 'INSUFFICIENT_CREDITS', outcome: 'SKIPPED_INSUFFICIENT_CREDITS' };
  }
  return null;
}
