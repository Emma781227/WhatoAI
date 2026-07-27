import type { AiStructuredOutput } from './structured-output';

/**
 * Validation SÉMANTIQUE déterministe, appliquée APRÈS parseAiStructuredOutput
 * (qui ne vérifie que la forme). Motivation : une sortie peut être Zod-valide
 * mais métier-incohérente — ex. `SUGGEST_REPLY` dont le texte annonce « je vous
 * mets en relation avec un conseiller » (observé au test réel).
 *
 * Cette couche NE RÉÉCRIT JAMAIS le texte du modèle (exigence). Elle rend une
 * DÉCISION que l'orchestrateur applique :
 * - CONSISTENT   : sortie cohérente, utilisable telle quelle ;
 * - FORCE_HANDOFF: incohérence « sûre » → convertir en handoff contrôlé ;
 * - INVALID_OUTPUT: incohérence structurelle → reprise contrôlée puis handoff.
 */

export type AiSemanticDecision = 'CONSISTENT' | 'FORCE_HANDOFF' | 'INVALID_OUTPUT';

export interface AiSemanticVerdict {
  decision: AiSemanticDecision;
  /** Code machine de l'incohérence (null si cohérent). */
  issue: string | null;
  detail: string | null;
}

/**
 * Expressions annonçant une mise en relation avec un HUMAIN (FR + EN). Une telle
 * annonce dans un SUGGEST_REPLY est incohérente : l'action aurait dû être
 * HANDOFF (règles 1 et 4).
 */
const HUMAN_HANDOFF_PATTERNS: RegExp[] = [
  // Français
  /(mets?|mettre|mise|met)\s+en\s+relation/i,
  /en\s+relation\s+avec\s+(un|une|nos?|notre|votre|le|la)/i,
  /\b(un|une|nos?|des|le|la|votre|mon|notre)\s+conseill\w+/i,
  /\b(un|une|nos?|des|le|la|votre)\s+agents?\b/i,
  /\b(un|une|nos?|des|le|la|votre)\s+coll[eè]gues?\b/i,
  /\b(un|une|nos?|des|le|la|votre)\s+responsables?\b/i,
  /membre\s+de\s+(l['’]|notre\s+)?[eé]quipe/i,
  /\bun\s+humain\b/i,
  /je\s+vous\s+(oriente|redirige|transf[eè]re|passe)\s+(vers|à|au)/i,
  /transf[eé]r\w*\s+(vers|à|au|votre|un|une)/i,
  // Anglais
  /connect\s+you\s+(with|to)/i,
  /put\s+you\s+(through|in\s+touch)/i,
  /transfer\s+you\b/i,
  /\b(a|an|our|one\s+of\s+our)\s+(human|agent|representative|rep|colleague|specialist|advisor|teammate|team\s+member|staff)\b/i,
  /our\s+team\s+will\s+(get\s+back|contact|reach|be\s+in\s+touch)/i,
  /get\s+(you\s+)?(someone|a\s+colleague|a\s+human|a\s+representative)\b/i,
];

/** Le texte annonce-t-il un transfert humain ? */
export function announcesHumanHandoff(text: string): boolean {
  return HUMAN_HANDOFF_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Affirmations métier vérifiables (prix, stock, horaires, statut de commande).
 * Sert la règle 3 : une telle affirmation SANS `usedBusinessData` est une
 * invention potentielle → handoff.
 */
const BUSINESS_ASSERTION_PATTERNS: RegExp[] = [
  // Prix chiffré / devise
  /\d[\d\s.,]*\s*(€|\$|fcfa|xaf|eur|usd|cfa)/i,
  /(€|\$)\s*\d/i,
  /(prix|tarif|co[uû]te?|price|cost)\b[^.?!]*\d/i,
  // Disponibilité / stock affirmés
  /\b(est|sont|c['’]est|nous\s+sommes|on\s+est|il\s+(y\s+)?en\s+reste)\b[^.?!]*\b(disponible|en\s+stock|dispo)\b/i,
  /\b(is|are|it['’]s|we\s+(do\s+)?have|there\s+(is|are))\b[^.?!]*\b(available|in\s+stock)\b/i,
  /\b(en\s+rupture|out\s+of\s+stock)\b/i,
  // Horaires affirmés
  /\b(nous\s+sommes|on\s+est|c['’]est|we\s+are|we['’]re|it['’]s)\b[^.?!]*\b(ouverts?|ferm[eé]s?|open|closed)\b/i,
  /\b(ouverts?|open)\b[^.?!]*\b(le|les|de|à|from|on|until|jusqu)\b/i,
  // Statut de commande affirmé (radicals sans \w+ : les suffixes accentués
  // comme « expédiée » ne sont pas des \w en regex JS).
  /\b(commande|order)\b[^.?!]*\b(exp[eé]di|livr|pr[eé]par|shipped|delivered|processing|ready|en\s+cours)/i,
];

/** Le texte affirme-t-il une donnée métier vérifiable ? */
export function assertsBusinessFact(text: string): boolean {
  return BUSINESS_ASSERTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Évalue la cohérence sémantique d'une sortie déjà validée par Zod.
 * Jamais de réécriture : renvoie une décision, l'orchestrateur agit.
 */
export function evaluateAiOutputSemantics(output: AiStructuredOutput): AiSemanticVerdict {
  const consistent: AiSemanticVerdict = { decision: 'CONSISTENT', issue: null, detail: null };

  if (output.action === 'SUGGEST_REPLY') {
    const reply = output.replyText ?? '';
    // Règles 1 + 4 : une réponse qui annonce un transfert humain doit être un
    // HANDOFF, pas un SUGGEST_REPLY.
    if (announcesHumanHandoff(reply)) {
      return {
        decision: 'FORCE_HANDOFF',
        issue: 'SUGGEST_ANNOUNCES_HANDOFF',
        detail: 'Un SUGGEST_REPLY annonce une mise en relation humaine.',
      };
    }
    // Règle 3 : affirmation métier sans donnée vérifiée → invention potentielle.
    if (!output.usedBusinessData && assertsBusinessFact(reply)) {
      return {
        decision: 'FORCE_HANDOFF',
        issue: 'UNVERIFIED_BUSINESS_CLAIM',
        detail: 'Affirmation prix/stock/horaires/commande sans usedBusinessData.',
      };
    }
    return consistent;
  }

  if (output.action === 'HANDOFF') {
    // Règle 2 : HANDOFF exige une raison (Zod le garantit déjà ; double filet).
    if ((output.handoffReason ?? '').trim() === '') {
      return {
        decision: 'INVALID_OUTPUT',
        issue: 'HANDOFF_MISSING_REASON',
        detail: 'HANDOFF sans handoffReason.',
      };
    }
    // Règle 2 : un HANDOFF ne doit pas porter une réponse commerciale affirmative.
    const reply = (output.replyText ?? '').trim();
    if (reply !== '' && assertsBusinessFact(reply)) {
      return {
        decision: 'INVALID_OUTPUT',
        issue: 'HANDOFF_WITH_AFFIRMATIVE_REPLY',
        detail: 'HANDOFF contenant une réponse commerciale affirmative.',
      };
    }
    return consistent;
  }

  // NO_REPLY : rien à vérifier sémantiquement.
  return consistent;
}
