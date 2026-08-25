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
/**
 * Média porté par un message entrant, tel que DÉCLARÉ par le fournisseur.
 *
 * ⚠️ `externalMediaId` est la seule prise sur le fichier : Meta ne conserve le
 * binaire que quelques semaines et ne fournit aucun autre moyen de le retrouver.
 * Le perdre à l'ingestion, c'est le perdre DÉFINITIVEMENT — d'où sa capture
 * dès le contrat normalisé, avant toute décision de téléchargement.
 *
 * Aucune URL n'est transportée ici : celle de Meta est temporaire et exige le
 * token du tenant, elle n'a donc de sens qu'au moment du téléchargement.
 */
export interface NormalizedInboundMedia {
  externalMediaId: string;
  /** Type MIME annoncé (jamais une autorité : re-vérifié au téléchargement). */
  mimeType: string | null;
  /** Nom d'origine — fourni pour les documents uniquement, en pratique. */
  fileName: string | null;
  /** Taille annoncée en octets, si le fournisseur la donne. */
  sizeBytes: number | null;
  /** Empreinte fournie par le fournisseur, conservée telle quelle. */
  sha256: string | null;
  /** Note vocale (audio enregistré) plutôt qu'un fichier audio joint. */
  voice: boolean;
}

export interface NormalizedInboundMessageEvent {
  kind: 'message';
  /** Identifiant d'événement pour l'idempotence de la durable inbox. */
  externalEventId: string;
  externalMessageId: string;
  /** Numéro de l'expéditeur, tel que fourni (normalisation E.164 en aval). */
  from: string;
  displayName?: string;
  messageType: InboundMessageContentType;
  /**
   * Texte écrit par le client : corps d'un message TEXT, ou LÉGENDE d'un média.
   * Une photo légendée « vous avez ça en 42 ? » porte une vraie question — la
   * jeter reviendrait à ignorer le message.
   */
  text: string | null;
  /** Média joint, si le message en porte un. */
  media?: NormalizedInboundMedia | null;
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
 * Profil WhatsApp Business (endpoint Graph `whatsapp_business_profile`). Champs
 * publics affichés au client final. `profilePictureUrl` est en LECTURE seule
 * ici : la mise à jour de la photo passe par l'API Resumable Upload de Meta
 * (handle), volontairement hors périmètre de cette phase.
 */
export interface WhatsAppBusinessProfile {
  about: string | null;
  address: string | null;
  description: string | null;
  email: string | null;
  vertical: string | null;
  websites: string[];
  profilePictureUrl: string | null;
}

/** Champs modifiables du profil. `undefined` = inchangé ; '' = effacement. */
export interface WhatsAppBusinessProfileUpdate {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  vertical?: string;
  websites?: string[];
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
