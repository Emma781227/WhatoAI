/**
 * Types du contrat provider WhatsApp. Ce package est du TypeScript pur :
 * AUCUNE dépendance NestJS ou Prisma — il est consommé par l'API et le worker.
 * Le provider TRADUIT les entrées/sorties du fournisseur ; il ne contient
 * jamais de logique métier (contacts, conversations, permissions, Socket.IO).
 */

export type WhatsAppProviderName = 'MOCK' | 'META_CLOUD';

export type InboundDeliveryStatus = 'DELIVERED' | 'READ' | 'FAILED';

/**
 * Type de contenu d'un message entrant — le VRAI type est conservé (décision
 * validée) : on ne convertit jamais techniquement un média en texte. Seul
 * TEXT porte un contenu texte ; l'UI génère le libellé « média non pris en
 * charge » pour les autres. Seuls les types SUPPORTÉS déclenchent l'IA (phase
 * ultérieure).
 */
export type InboundMessageContentType =
  | 'TEXT'
  | 'IMAGE'
  | 'AUDIO'
  | 'VIDEO'
  | 'DOCUMENT'
  | 'LOCATION'
  | 'CONTACTS'
  | 'STICKER'
  | 'UNSUPPORTED';

export const SUPPORTED_INBOUND_MESSAGE_TYPES: readonly InboundMessageContentType[] = ['TEXT'];

export function isSupportedInboundMessageType(type: InboundMessageContentType): boolean {
  return SUPPORTED_INBOUND_MESSAGE_TYPES.includes(type);
}

/**
 * Événement webhook brut, tel que reçu du fournisseur.
 * - `body` : payload JSON parsé, utilisé pour le PARSING ;
 * - `rawBody` : bytes EXACTS reçus, utilisés pour la vérification HMAC Meta
 *   (le JSON re-sérialisé ne redonne pas la même signature) — jamais persisté ;
 * - `signature` : valeur du header X-Hub-Signature-256, jamais persistée ni loggée.
 */
export interface RawInboundEvent {
  body: unknown;
  rawBody?: string;
  signature?: string;
}

/** Message client entrant, normalisé — format interne unique de la pipeline. */
export interface NormalizedInboundMessageEvent {
  kind: 'message';
  /** Identifiant d'événement pour l'idempotence de la durable inbox. */
  externalEventId: string;
  externalMessageId: string;
  /** Numéro de l'expéditeur, tel que fourni (normalisation E.164 en aval). */
  from: string;
  displayName?: string;
  messageType: InboundMessageContentType;
  /** Contenu texte — présent seulement pour TEXT ; null pour les médias. */
  text: string | null;
  /** Timestamp FOURNISSEUR (ISO 8601) — base du calcul de la fenêtre 24 h. */
  providerTimestamp: string;
}

/** Mise à jour de statut d'un message sortant, normalisée. */
export interface NormalizedInboundStatusEvent {
  kind: 'status';
  externalEventId: string;
  /** Id externe du message sortant concerné. */
  externalMessageId: string;
  status: InboundDeliveryStatus;
  providerTimestamp: string;
  errorCode?: string;
  errorMessage?: string;
}

export type NormalizedInboundEvent =
  | NormalizedInboundMessageEvent
  | NormalizedInboundStatusEvent;

export interface SendTextMessageInput {
  channel: {
    id: string;
    phoneNumber: string;
  };
  /** Destinataire au format E.164. */
  to: string;
  text: string;
  /**
   * Identifiant stable du cycle d'envoi (jobId BullMQ). Transmis au provider
   * pour traçabilité ; Meta ne fournit AUCUNE idempotence externe dans cette
   * phase — un envoi réussi dont la réponse réseau est perdue peut être
   * retenté et donc dupliqué chez le destinataire (risque documenté).
   */
  dispatchId: string;
}

export interface SendMessageResult {
  externalMessageId: string;
}

export interface MarkMessageAsReadInput {
  channel: {
    id: string;
    phoneNumber: string;
  };
  externalMessageId: string;
}

/**
 * Classification d'une erreur provider — pilote la décision retry du worker.
 * - RETRYABLE : transitoire (rate limit, timeout, 5xx) → nouvelle tentative ;
 * - NON_RETRYABLE : définitif (numéro invalide, payload) → FAILED immédiat ;
 * - REQUIRES_TEMPLATE : fenêtre 24 h fermée → FAILED (template hors scope) ;
 * - CONFIGURATION_ERROR : token/permissions → FAILED, alerte config.
 */
export type ProviderErrorClass =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'REQUIRES_TEMPLATE'
  | 'CONFIGURATION_ERROR';

/**
 * Échec technique d'un appel provider. Le worker le traduit en transition
 * FAILED (ou en retry BullMQ selon `errorClass`) — jamais exposé tel quel au
 * client HTTP. Le message ne contient JAMAIS de secret (token filtré).
 */
export class WhatsAppProviderSendError extends Error {
  public readonly code: string;
  public readonly errorClass: ProviderErrorClass;

  constructor(message: string, code: string, errorClass: ProviderErrorClass = 'RETRYABLE') {
    super(message);
    this.name = 'WhatsAppProviderSendError';
    this.code = code;
    this.errorClass = errorClass;
  }
}
