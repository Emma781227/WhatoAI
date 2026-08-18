import type { AiInputMessage } from './types';

/**
 * Budget de contexte (CI-G1). TypeScript PUR et déterministe : mêmes entrées →
 * même sortie, aucun appel réseau, aucune dépendance provider. Le worker
 * assemble les données (boutique, règles, résumé, messages) ; ce module décide
 * seulement CE QUI TIENT dans le budget et CE QUI SAUTE.
 *
 * Pourquoi un budget en TOKENS et pas en messages : `contextMaxMessages` borne
 * un NOMBRE, pas un COÛT — 50 messages courts et 50 messages longs n'ont rien à
 * voir sur la facture. Le budget est un levier économique, pas une limite
 * technique du modèle.
 *
 * Règle d'or : on ne tronque JAMAIS en silence. `assembleContext` rapporte
 * exactement ce qui a été retiré, et le dernier message client (le déclencheur
 * du run) n'est jamais sacrifié — un contexte sans la question posée est pire
 * qu'un contexte cher.
 */

/**
 * Estimation locale du nombre de tokens d'un texte. Heuristique assumée
 * (~4 caractères par token sur du français/anglais mêlé), volontairement
 * PESSIMISTE d'un token par entrée pour couvrir les séparateurs de rôle.
 * On préfère surestimer : dépasser le budget coûte de l'argent, le sous-évaluer
 * n'en fait pas gagner.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4) + 1;
}

/** Estimation d'une liste de messages (rôles compris, forfaitairement). */
export function estimateMessagesTokens(messages: AiInputMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/**
 * Blocs de contexte, du PLUS prioritaire au moins prioritaire. Le prompt
 * système n'est pas un bloc : il porte les règles de sécurité et n'est jamais
 * tronqué. Ordre de sacrifice (en cas de dépassement) : l'historique brut
 * d'abord — c'est précisément ce que le résumé remplace (CI-G2).
 */
export interface AiContextBlocks {
  /** Faits statiques de la boutique (devise, fuseau, horaires résumés). */
  shopFacts: string[];
  /** Règles commerciales définies par le commerçant (bornées côté API). */
  businessRules?: string | null;
  /** Résumé roulant de la conversation (CI-G2) — remplace l'historique ancien. */
  conversationSummary?: string | null;
  /** Historique brut, du plus ANCIEN au plus RÉCENT. */
  messages: AiInputMessage[];
}

export interface AiContextAssembly {
  shopFacts: string[];
  businessRules: string | null;
  conversationSummary: string | null;
  messages: AiInputMessage[];
  /** Tokens estimés réellement retenus (hors prompt système). */
  estimatedTokens: number;
  /** Messages retirés faute de budget (les plus anciens). Jamais silencieux. */
  droppedMessageCount: number;
  /** Le résumé a-t-il dû être abandonné (budget minuscule) ? */
  droppedSummary: boolean;
  /** Les règles de la boutique ont-elles dû être abandonnées ? */
  droppedBusinessRules: boolean;
}

/**
 * Assemble le contexte sous contrainte de budget. Stratégie, dans l'ordre :
 * 1. les faits boutique sont toujours gardés (quelques dizaines de tokens) ;
 * 2. on garde les messages les PLUS RÉCENTS tant qu'ils tiennent — le dernier
 *    est conservé même s'il dépasse à lui seul le budget ;
 * 3. si le budget est saturé, on abandonne le résumé, puis les règles.
 *
 * `budgetTokens` <= 0 est traité comme « pas de budget » : on garde tout (le
 * garde-fou reste `contextMaxMessages` en amont).
 */
export function assembleContext(
  blocks: AiContextBlocks,
  budgetTokens: number,
): AiContextAssembly {
  const summary = blocks.conversationSummary?.trim() ? blocks.conversationSummary.trim() : null;
  const rules = blocks.businessRules?.trim() ? blocks.businessRules.trim() : null;
  const factsTokens = blocks.shopFacts.reduce((total, fact) => total + estimateTokens(fact), 0);

  if (budgetTokens <= 0) {
    return {
      shopFacts: blocks.shopFacts,
      businessRules: rules,
      conversationSummary: summary,
      messages: blocks.messages,
      estimatedTokens:
        factsTokens +
        (rules ? estimateTokens(rules) : 0) +
        (summary ? estimateTokens(summary) : 0) +
        estimateMessagesTokens(blocks.messages),
      droppedMessageCount: 0,
      droppedSummary: false,
      droppedBusinessRules: false,
    };
  }

  let keptRules = rules;
  let keptSummary = summary;
  let droppedBusinessRules = false;
  let droppedSummary = false;

  // Les faits boutique sont incompressibles ; ce qui reste finance le reste.
  let remaining = budgetTokens - factsTokens;

  if (keptRules !== null) {
    const cost = estimateTokens(keptRules);
    if (cost <= remaining) {
      remaining -= cost;
    } else {
      keptRules = null;
      droppedBusinessRules = true;
    }
  }
  if (keptSummary !== null) {
    const cost = estimateTokens(keptSummary);
    if (cost <= remaining) {
      remaining -= cost;
    } else {
      keptSummary = null;
      droppedSummary = true;
    }
  }

  // Historique : on remonte du plus RÉCENT vers le plus ancien.
  const keptReversed: AiInputMessage[] = [];
  for (let index = blocks.messages.length - 1; index >= 0; index -= 1) {
    const message = blocks.messages[index];
    const cost = estimateTokens(message.content);
    if (cost <= remaining) {
      remaining -= cost;
      keptReversed.push(message);
      continue;
    }
    // Le message le plus récent est le déclencheur : jamais sacrifié.
    if (keptReversed.length === 0) {
      remaining -= cost;
      keptReversed.push(message);
      continue;
    }
    break;
  }

  const messages = keptReversed.reverse();
  const estimatedTokens =
    factsTokens +
    (keptRules ? estimateTokens(keptRules) : 0) +
    (keptSummary ? estimateTokens(keptSummary) : 0) +
    estimateMessagesTokens(messages);

  return {
    shopFacts: blocks.shopFacts,
    businessRules: keptRules,
    conversationSummary: keptSummary,
    messages,
    estimatedTokens,
    droppedMessageCount: blocks.messages.length - messages.length,
    droppedSummary,
    droppedBusinessRules,
  };
}
