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

/** Événement temps réel qu'un outil demande d'émettre APRÈS commit (générique). */
export interface AiToolRealtimeEvent {
  event: string;
  payload: unknown;
}

/** Résultat d'un outil, filtré et borné, réinjecté au modèle. */
export interface AiToolRunResult {
  /** Charge utile JSON-sérialisable, SANS donnée sensible (coût, adresse, note). */
  result: unknown;
  /** Résumé compact persisté dans AiToolCall.resultSummaryFiltered. */
  summary: Record<string, unknown>;
  /**
   * Événements temps réel à émettre par l'orchestrateur APRÈS l'exécution (la
   * transaction de l'outil est déjà committée). Les outils WRITE panier y
   * placent `cart.updated` — le panneau Panier de l'inbox bouge en direct.
   */
  realtimeEvents?: AiToolRealtimeEvent[];
}

/**
 * Métadonnées de l'appel courant — position dans la boucle d'outils du run.
 * Les outils WRITE en dérivent une clé d'idempotence stable
 * (`ai.<aiRunId>.<round>.<sequence>`) pour dédupliquer un rejeu DANS le run.
 */
export interface AiToolCallMeta {
  round: number;
  sequence: number;
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
  /**
   * Reçoit un contexte déjà scopé. Les outils LECTURE ignorent `meta` ; les
   * outils WRITE l'utilisent pour l'idempotence. `prisma` est le client de base
   * — un outil WRITE ouvre sa propre transaction.
   */
  run(
    prisma: PrismaService,
    ctx: AiToolContext,
    input: TInput,
    meta: AiToolCallMeta,
  ): Promise<AiToolRunResult>;
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
