/**
 * Types du contrat provider IA. Ce package est du TypeScript pur : AUCUNE
 * dépendance NestJS, Prisma ou SDK fournisseur, et AUCUNE lecture de
 * `process.env` (décision D10 validée) — toute configuration est INJECTÉE.
 *
 * Le provider TRADUIT les entrées/sorties du modèle ; il ne contient jamais de
 * logique métier (tenant, catalogue, commandes, permissions) et n'accède
 * JAMAIS à la base. La boucle d'outils est pilotée par le worker (D6 validée),
 * ce qui garde le provider sans état.
 */

export type AiProviderName = 'MOCK' | 'GEMINI';

/**
 * Mode IA — également stocké par Shop dans `AiConfiguration`.
 * Ordre de priorité (validé) : `AI_MODE=DISABLED` est un coupe-circuit global ;
 * sinon `AiConfiguration.mode` fait autorité ; sinon `AI_MODE` sert de défaut.
 */
export type AiMode = 'DISABLED' | 'SUGGEST_ONLY' | 'AUTO_REPLY';

/** Rôle d'un message dans le contexte envoyé au modèle. */
export type AiMessageRole = 'SYSTEM' | 'CUSTOMER' | 'AGENT';

/**
 * Message du contexte conversationnel. Volontairement pauvre : pas d'id, pas
 * d'auteur nominatif, pas de métadonnée interne — ce qui n'est pas nécessaire
 * au modèle ne lui est pas envoyé (section 35 du cahier des charges).
 */
export interface AiInputMessage {
  role: AiMessageRole;
  content: string;
}

/** Déclaration d'un outil métier exposé au modèle (lecture seule en phase B). */
export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema des paramètres — dérivé du schéma Zod côté worker. */
  parameters: Record<string, unknown>;
}

/**
 * Métadonnées OPAQUES rattachées à un appel d'outil, propres au fournisseur.
 * Jeton technique ÉPHÉMÈRE (valable uniquement pendant le même AiRun) : jamais
 * persisté, jamais exposé (DTO/API/frontend/socket/audit), jamais loggé, jamais
 * traité comme donnée métier. Réémis TEL QUEL au fournisseur — jamais décodé,
 * normalisé ni interprété.
 */
export interface AiToolCallProviderMetadata {
  /**
   * `thoughtSignature` Gemini : signature opaque renvoyée avec le functionCall
   * du 1ᵉʳ tour, EXIGÉE à l'identique lors de la continuation (sinon 400).
   */
  thoughtSignature?: string;
}

/** Demande d'appel d'outil émise par le modèle. */
export interface AiToolCall {
  /** Identifiant de corrélation local (le modèle peut demander plusieurs outils). */
  id: string;
  name: string;
  /** Arguments BRUTS du modèle — jamais exécutés sans validation Zod côté worker. */
  arguments: Record<string, unknown>;
  /** Métadonnées opaques du fournisseur (ex. thoughtSignature) — jamais persistées/exposées. */
  providerMetadata?: AiToolCallProviderMetadata;
}

/** Résultat d'un outil, réinjecté au modèle au tour suivant. */
export interface AiToolResult {
  id: string;
  name: string;
  /** Contenu filtré : jamais de coût, note interne, secret ou donnée d'un autre tenant. */
  result: unknown;
  /** Un outil en erreur est signalé au modèle, sans détail technique interne. */
  isError?: boolean;
}

export type AiFinishReason =
  | 'STOP'
  | 'TOOL_CALLS'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'OTHER';

/** Usage brut remonté par le fournisseur — jamais de coût financier calculé en dur. */
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * Réponse d'un tour de modèle. Soit le modèle demande des outils
 * (`toolCalls` non vide, `finishReason: 'TOOL_CALLS'`), soit il produit sa
 * sortie finale (`text` à valider par `parseAiStructuredOutput`).
 */
export interface AiProviderResponse {
  /** Texte brut du modèle — JAMAIS interprété sans validation structurée. */
  text: string | null;
  toolCalls: AiToolCall[];
  finishReason: AiFinishReason;
  usage: AiUsage;
  /** Latence de l'appel fournisseur, mesurée par le provider. */
  latencyMs: number;
  /** Modèle RÉELLEMENT servi (rapporté par le fournisseur) → resolvedModel. */
  modelVersion: string | null;
}

/** Entrée d'un tour de génération. */
export interface AiGenerateInput {
  systemPrompt: string;
  messages: AiInputMessage[];
  tools: AiToolDefinition[];
  maxOutputTokens: number;
}

/** Entrée d'un tour de continuation après exécution des outils. */
export interface AiContinueInput extends AiGenerateInput {
  /** Historique des tours d'outils déjà joués, dans l'ordre. */
  previousToolCalls: AiToolCall[];
  toolResults: AiToolResult[];
}

export interface AiConfigurationCheck {
  ok: boolean;
  model?: string;
}
