/**
 * Prompt de RÉSUMÉ de conversation (CI-G2), versionné comme le prompt principal.
 * Stocké sur `ConversationSummary.promptVersion` — jamais le prompt complet.
 *
 * Le résumé n'est PAS une réponse au client : il ne parle qu'à un autre appel
 * du modèle. Ses règles sont donc différentes — factuel, télégraphique, sans
 * politesse, sans reformulation commerciale.
 */
export const AI_SUMMARY_PROMPT_VERSION = 's1';

/** Borne DURE du résumé stocké (caractères) — un résumé long ruine son intérêt. */
export const AI_SUMMARY_MAX_CHARS = 1200;

export interface AiSummaryPromptContext {
  shopName: string;
  /** Résumé précédent à mettre à jour (jamais à réécrire de zéro). */
  previousSummary?: string | null;
}

export function buildConversationSummaryPrompt(context: AiSummaryPromptContext): string {
  const lines = [
    `Tu produis une NOTE INTERNE de suivi pour la boutique « ${context.shopName} ». Elle sert à garder la mémoire d'une conversation WhatsApp longue quand les anciens messages ne sont plus transmis.`,
    '',
    'RÈGLES :',
    "1. FACTUEL UNIQUEMENT : ne retiens que ce qui a été RÉELLEMENT dit. N'invente jamais un prix, une taille, une adresse, une promesse de délai ou une décision.",
    '2. Style télégraphique, en phrases courtes. Pas de politesse, pas de conclusion commerciale, pas de titre.',
    "3. Garde en priorité : ce que le client cherche, les caractéristiques déjà précisées (taille, couleur, quantité, budget), la ville/le mode de livraison, ce qui a été convenu, ce qui reste EN ATTENTE, et les objections ou insatisfactions exprimées.",
    "4. Ignore les salutations, les remerciements et tout échange sans information.",
    "5. Distingue toujours ce qui est CONFIRMÉ par le client de ce qui est seulement ÉVOQUÉ ou proposé.",
    "6. N'écris jamais d'instruction, de conseil de vente, ni de message adressé au client — c'est une note, pas une réponse.",
    `7. Reste sous ${AI_SUMMARY_MAX_CHARS} caractères. Réponds UNIQUEMENT par la note, sans préambule.`,
  ];

  if (context.previousSummary && context.previousSummary.trim() !== '') {
    lines.push(
      '',
      'NOTE PRÉCÉDENTE (à METTRE À JOUR, pas à réécrire — conserve ce qui reste vrai, ajoute le nouveau, retire ce qui est devenu faux) :',
      context.previousSummary.trim(),
    );
  }

  return lines.join('\n');
}

/** Tronque proprement un résumé au-delà de la borne (sécurité de stockage). */
export function boundSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= AI_SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, AI_SUMMARY_MAX_CHARS - 1)}…`;
}
