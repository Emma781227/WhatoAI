import { z } from 'zod';

import { AiProviderError } from './errors';

/**
 * Sortie structurée EXIGÉE du modèle (section 28 du cahier des charges).
 * Règle absolue : on ne fait JAMAIS confiance à une réponse JSON non validée.
 * Le mode JSON du fournisseur est demandé, mais la validation Zod reste la
 * seule autorité — un fournisseur peut toujours renvoyer autre chose.
 */

export const AI_ACTIONS = ['SUGGEST_REPLY', 'HANDOFF', 'NO_REPLY'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/** Borne de longueur d'une suggestion : WhatsApp coupe au-delà, et le prompt exige de la brièveté. */
export const AI_REPLY_MAX_LENGTH = 4096;
export const AI_HANDOFF_REASON_MAX_LENGTH = 500;

const baseSchema = z.object({
  action: z.enum(AI_ACTIONS),
  replyText: z.string().max(AI_REPLY_MAX_LENGTH).nullable(),
  handoffReason: z.string().max(AI_HANDOFF_REASON_MAX_LENGTH).nullable(),
  /**
   * Signal SECONDAIRE uniquement (ajustement 16 validé) : l'éligibilité
   * AUTO_REPLY repose d'abord sur des règles déterministes, jamais
   * principalement sur cette valeur auto-déclarée par le modèle.
   */
  confidence: z.number().min(0).max(1),
  usedBusinessData: z.boolean(),
});

/**
 * Cohérence entre l'action et les champs : une action sans son contenu
 * obligatoire est une sortie invalide, pas une sortie à « rattraper ».
 */
export const aiStructuredOutputSchema = baseSchema
  .refine((value) => value.action !== 'SUGGEST_REPLY' || (value.replyText?.trim() ?? '') !== '', {
    message: 'SUGGEST_REPLY exige un replyText non vide.',
    path: ['replyText'],
  })
  .refine(
    (value) => value.action !== 'HANDOFF' || (value.handoffReason?.trim() ?? '') !== '',
    { message: 'HANDOFF exige un handoffReason non vide.', path: ['handoffReason'] },
  );

export type AiStructuredOutput = z.infer<typeof aiStructuredOutputSchema>;

/** JSON Schema transmis au fournisseur pour demander le mode structuré. */
export const AI_STRUCTURED_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...AI_ACTIONS] },
    replyText: { type: 'string', nullable: true },
    handoffReason: { type: 'string', nullable: true },
    confidence: { type: 'number' },
    usedBusinessData: { type: 'boolean' },
  },
  required: ['action', 'replyText', 'handoffReason', 'confidence', 'usedBusinessData'],
};

/**
 * Extrait le JSON d'une réponse modèle. Certains modèles encadrent leur sortie
 * d'une clôture Markdown même en mode JSON : on la retire, sans jamais tenter
 * de « réparer » un JSON structurellement cassé (ce serait deviner).
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Valide la sortie du modèle. Lève une `AiProviderError` INVALID_OUTPUT —
 * l'appelant décide alors d'une unique reprise contrôlée, puis bascule en
 * HANDOFF. Aucune réponse n'est jamais envoyée sur la base d'une sortie
 * invalide.
 */
export function parseAiStructuredOutput(text: string | null): AiStructuredOutput {
  if (text === null || text.trim() === '') {
    throw new AiProviderError('Réponse IA vide.', 'AI_EMPTY_OUTPUT', 'INVALID_OUTPUT');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    throw new AiProviderError('Réponse IA non JSON.', 'AI_INVALID_JSON', 'INVALID_OUTPUT');
  }

  const result = aiStructuredOutputSchema.safeParse(parsed);
  if (!result.success) {
    // Le détail Zod suffit au diagnostic ; on ne renvoie jamais le texte brut
    // du modèle, qui peut contenir des données conversationnelles.
    throw new AiProviderError(
      `Sortie IA non conforme : ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      'AI_INVALID_OUTPUT_SHAPE',
      'INVALID_OUTPUT',
    );
  }
  return result.data;
}
