/**
 * Contrats des jobs BullMQ entre l'API (producteur) et le worker (consommateur).
 *
 * Règle de durabilité : un job ne porte JAMAIS le contenu métier — uniquement
 * des références vers PostgreSQL (durable inbox / message). Redis peut être
 * perdu à tout moment : les sweeps republient depuis la base.
 */

/** whatsapp-inbound — jobId = inboundEventId (idempotence de publication). */
export interface WhatsAppInboundJobData {
  inboundEventId: string;
}

/**
 * whatsapp-outbound — jobId = dispatchId : une republication outbox du même
 * cycle d'envoi ne crée jamais un second job logique. Un retry explicite d'un
 * message FAILED génère un nouveau dispatchId (donc un nouveau job).
 */
export interface WhatsAppOutboundJobData {
  messageId: string;
  dispatchId: string;
}

/**
 * whatsapp-status — statuts SIMULÉS par le provider MOCK (jobs différés
 * programmés par le worker après un envoi réussi). Les statuts venant d'un
 * webhook réel passent, eux, par la durable inbox (whatsapp-inbound).
 */
export interface WhatsAppStatusJobData {
  channelId: string;
  externalMessageId: string;
  status: 'DELIVERED' | 'READ' | 'FAILED';
  providerTimestamp: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Payload de l'OutboxEvent WHATSAPP_MESSAGE_SEND_REQUESTED. */
export interface WhatsAppMessageSendRequestedPayload {
  messageId: string;
  dispatchId: string;
}
