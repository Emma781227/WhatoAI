import type {
  MarkMessageAsReadInput,
  NormalizedInboundEvent,
  RawInboundEvent,
  SendMessageResult,
  SendTextMessageInput,
  WhatsAppProviderName,
} from './types';

export interface WhatsAppProvider {
  getProviderName(): WhatsAppProviderName;

  /**
   * Authenticité de l'événement (HMAC-SHA256 pour Meta). Retourne false pour
   * tout événement non signé/mal formé — l'appelant répond 401/403 sans traiter.
   */
  validateInboundEvent(event: RawInboundEvent): boolean;

  /** Traduit un webhook brut en événements normalisés (peut en contenir plusieurs). */
  parseInboundEvent(event: RawInboundEvent): NormalizedInboundEvent[];

  sendTextMessage(input: SendTextMessageInput): Promise<SendMessageResult>;

  markMessageAsRead(input: MarkMessageAsReadInput): Promise<void>;
}
