import type { ZodTypeAny } from 'zod';

import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Contexte d'exécution d'un outil métier IA. Le scoping tenant est
 * OBLIGATOIRE et STRUCTUREL : chaque champ est requis, et TOUTE requête d'outil
 * doit filtrer sur ces valeurs. Le modèle n'a JAMAIS d'accès Prisma générique —
 * il ne voit que les six outils déclarés, chacun scopé par ce contexte.
 */
export interface AiToolContext {
  organizationId: string;
  shopId: string;
  conversationId: string;
  /** Contact de la conversation courante — barrière anti-fuite (commandes d'autrui). */
  contactId: string;
  /** Run porteur — pour tracer chaque appel dans AiToolCall. */
  aiRunId: string;
}

/** Résultat d'un outil, filtré et borné, réinjecté au modèle. */
export interface AiToolRunResult {
  /** Charge utile JSON-sérialisable, SANS donnée sensible (coût, adresse, note). */
  result: unknown;
  /** Résumé compact persisté dans AiToolCall.resultSummaryFiltered. */
  summary: Record<string, unknown>;
}

/**
 * Définition d'un outil dans le registre. `inputSchema` est STRICT (aucun
 * paramètre inconnu). `run` reçoit un contexte déjà scopé et ne fait que de la
 * LECTURE — seule exception documentée : request_human_handoff écrit un
 * ConversationHandoff (sa seule écriture métier autorisée).
 */
export interface AiToolDefinitionEntry<TInput = unknown> {
  name: string;
  description: string;
  /** JSON Schema des paramètres, transmis au modèle (function calling). */
  parameters: Record<string, unknown>;
  /** Schéma Zod STRICT (validé par l'exécuteur ; ZodDefault → input/output décalés). */
  inputSchema: ZodTypeAny;
  run(prisma: PrismaService, ctx: AiToolContext, input: TInput): Promise<AiToolRunResult>;
}

/** Erreur métier d'un outil (ressource introuvable/hors périmètre) — jamais un leak. */
export class AiToolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AiToolError';
  }
}
