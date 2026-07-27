import { Injectable, Logger } from '@nestjs/common';
import type { AiToolCallStatus } from '@whauto/database';

import { PrismaService } from '../../prisma/prisma.service';
import { AI_TOOL_REGISTRY } from './tool-registry';
import { AiToolError, type AiToolContext } from './tool-types';

/** Borne de sérialisation des champs persistés (jamais un dump illimité). */
const MAX_FILTERED_JSON = 4000;

export interface AiToolCallRef {
  round: number;
  sequence: number;
  timeoutMs: number;
}

export interface AiToolExecutionOutcome {
  toolName: string;
  status: AiToolCallStatus;
  /** Résultat filtré réinjecté au modèle (null si refusé/échoué). */
  result: unknown;
  isError: boolean;
  errorCode: string | null;
  latencyMs: number;
  aiToolCallId: string;
}

function boundedJson(value: unknown): unknown {
  const serialised = JSON.stringify(value ?? null);
  if (serialised.length <= MAX_FILTERED_JSON) {
    return value ?? null;
  }
  return { truncated: true, preview: serialised.slice(0, MAX_FILTERED_JSON) };
}

/**
 * Exécute UN appel d'outil demandé par le modèle. Barrières, dans l'ordre :
 * 1. outil inconnu → REJECTED (le modèle ne peut appeler que le registre) ;
 * 2. arguments non conformes au schéma STRICT → REJECTED (paramètre inconnu,
 *    type invalide, borne dépassée) ;
 * 3. timeout par outil → FAILED ;
 * 4. erreur métier (ressource hors périmètre) → FAILED, jamais un leak.
 *
 * CHAQUE issue est tracée dans AiToolCall avec argumentsFiltered et
 * resultSummaryFiltered UNIQUEMENT (bornés). L'orchestrateur (groupe suivant)
 * réinjecte `result` au modèle.
 */
@Injectable()
export class AiToolExecutor {
  private readonly logger = new Logger(AiToolExecutor.name);

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    ctx: AiToolContext,
    toolName: string,
    rawArgs: unknown,
    ref: AiToolCallRef,
  ): Promise<AiToolExecutionOutcome> {
    const startedAt = Date.now();
    const tool = AI_TOOL_REGISTRY[toolName];

    // 1. Outil inconnu — jamais exécuté (trace REJECTED directe).
    if (!tool) {
      return this.recordRejected(ctx, toolName, ref, boundedJson(rawArgs), 'UNKNOWN_TOOL', startedAt);
    }

    // 2. Validation STRICTE des arguments (trace REJECTED directe).
    const parsed = tool.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return this.recordRejected(ctx, toolName, ref, boundedJson(rawArgs), 'INVALID_ARGUMENTS', startedAt);
    }
    const argumentsFiltered = boundedJson(parsed.data);

    // 3. Trace créée AVANT exécution (PENDING → RUNNING).
    const call = await this.prisma.aiToolCall.create({
      data: {
        aiRunId: ctx.aiRunId,
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        toolName,
        round: ref.round,
        sequence: ref.sequence,
        argumentsFiltered: argumentsFiltered as never,
        status: 'PENDING',
      },
      select: { id: true },
    });
    await this.prisma.aiToolCall.update({ where: { id: call.id }, data: { status: 'RUNNING' } });

    try {
      // 4. Exécution bornée par un timeout par outil.
      const outcome = await this.withTimeout(tool.run(this.prisma, ctx, parsed.data), ref.timeoutMs);
      return this.finalize(call.id, toolName, 'SUCCEEDED', {
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        resultSummaryFiltered: boundedJson(outcome.summary),
        result: outcome.result,
      });
    } catch (error) {
      const errorCode =
        error instanceof AiToolError
          ? error.code
          : error instanceof Error && error.message === 'AI_TOOL_TIMEOUT'
            ? 'TOOL_TIMEOUT'
            : 'TOOL_ERROR';
      // 5. Échec (métier ou technique) : jamais un leak — code filtré seulement.
      this.logger.debug(`Outil ${toolName} en échec : ${errorCode}`);
      return this.finalize(call.id, toolName, 'FAILED', {
        latencyMs: Date.now() - startedAt,
        errorCode,
        resultSummaryFiltered: null,
        result: null,
      });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI_TOOL_TIMEOUT')), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Refus AVANT exécution : trace REJECTED directe (aucune ligne PENDING). */
  private async recordRejected(
    ctx: AiToolContext,
    toolName: string,
    ref: AiToolCallRef,
    argumentsFiltered: unknown,
    errorCode: string,
    startedAt: number,
  ): Promise<AiToolExecutionOutcome> {
    const call = await this.prisma.aiToolCall.create({
      data: {
        aiRunId: ctx.aiRunId,
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        toolName,
        round: ref.round,
        sequence: ref.sequence,
        argumentsFiltered: argumentsFiltered as never,
        status: 'REJECTED',
        latencyMs: Date.now() - startedAt,
        errorCode,
      },
      select: { id: true },
    });
    return {
      toolName,
      status: 'REJECTED',
      result: null,
      isError: true,
      errorCode,
      latencyMs: Date.now() - startedAt,
      aiToolCallId: call.id,
    };
  }

  private async finalize(
    callId: string,
    toolName: string,
    status: AiToolCallStatus,
    extra: { latencyMs: number; errorCode: string | null; resultSummaryFiltered: unknown; result: unknown },
  ): Promise<AiToolExecutionOutcome> {
    await this.prisma.aiToolCall.update({
      where: { id: callId },
      data: {
        status,
        latencyMs: extra.latencyMs,
        errorCode: extra.errorCode,
        resultSummaryFiltered: (extra.resultSummaryFiltered ?? undefined) as never,
      },
    });
    return {
      toolName,
      status,
      result: extra.result,
      isError: status !== 'SUCCEEDED',
      errorCode: extra.errorCode,
      latencyMs: extra.latencyMs,
      aiToolCallId: callId,
    };
  }
}
