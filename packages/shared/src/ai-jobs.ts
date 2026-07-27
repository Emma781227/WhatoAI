/**
 * Contrat du job BullMQ `ai-process-message` entre le producteur (worker
 * inbound / sweep de récupération) et le consommateur (processor IA).
 *
 * Règle de durabilité, IDENTIQUE aux jobs WhatsApp et RENFORCÉE pour l'IA
 * (ajustement 5 validé) : le job ne porte QUE des références vers PostgreSQL —
 * JAMAIS de texte client, de prompt, d'historique de conversation ni d'aucune
 * donnée métier. Redis peut être vidé à tout moment ; le processor relit tout
 * en base, et le sweep republie depuis PostgreSQL.
 *
 * jobId de debounce = `ai.debounce.<conversationId>` (séparateur '.' — BullMQ
 * interdit ':' dans le jobId d'un job différé). Il est volontairement keyé par
 * CONVERSATION, pas par message : un nouveau message rapproché REMPLACE le job
 * différé en attente pour porter le dernier déclencheur (debounce). L'autorité
 * d'idempotence reste la BASE (`AiRun.triggerMessageId` unique + index partiel
 * « un seul run actif par conversation »), jamais le jobId seul.
 */
export interface AiProcessMessageJobData {
  organizationId: string;
  shopId: string;
  conversationId: string;
  /** Dernier message client de la fenêtre de debounce — déclencheur du run. */
  triggerMessageId: string;
  channelId: string;
  /** Horodatage ISO de la planification (diagnostic ; jamais une donnée métier). */
  scheduledAt: string;
}

/** Préfixe du jobId de debounce — keyé par conversation, séparateur '.' obligatoire. */
export function aiDebounceJobId(conversationId: string): string {
  return `ai.debounce.${conversationId}`;
}
