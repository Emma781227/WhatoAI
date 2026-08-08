import { DomainError } from './errors';

/** 404 pour un canal inexistant OU d'une autre organisation (anti-énumération). */
export class WhatsAppChannelNotFoundError extends DomainError {
  constructor() {
    super('WhatsApp channel not found.', 'WHATSAPP_CHANNEL_NOT_FOUND', 404);
    this.name = 'WhatsAppChannelNotFoundError';
  }
}

/** Un canal actif (CONNECTING/CONNECTED/SUSPENDED) occupe déjà le slot de la Shop. */
export class WhatsAppChannelAlreadyActiveError extends DomainError {
  constructor() {
    super(
      'An active WhatsApp channel already exists for this shop.',
      'WHATSAPP_CHANNEL_ALREADY_ACTIVE',
      409,
    );
    this.name = 'WhatsAppChannelAlreadyActiveError';
  }
}

export class WhatsAppChannelNotConnectedError extends DomainError {
  constructor() {
    super(
      'The WhatsApp channel is not connected.',
      'WHATSAPP_CHANNEL_NOT_CONNECTED',
      409,
    );
    this.name = 'WhatsAppChannelNotConnectedError';
  }
}

/** META_CLOUD est prévu dans le modèle mais volontairement non implémenté dans cette phase. */
export class WhatsAppProviderNotImplementedError extends DomainError {
  constructor(provider: string) {
    super(
      `WhatsApp provider not implemented: ${provider}.`,
      'WHATSAPP_PROVIDER_NOT_IMPLEMENTED',
      501,
    );
    this.name = 'WhatsAppProviderNotImplementedError';
  }
}

/**
 * 422 : multi-tenant Meta activé mais aucune connexion WhatsApp active (numéro +
 * credential ACTIVE) n'est résolvable pour ce Shop. On ÉCHOUE plutôt que
 * d'envoyer depuis le mauvais numéro (jamais de repli silencieux sur le pilote).
 */
export class WhatsAppConnectionNotResolvedError extends DomainError {
  constructor(shopId: string) {
    super(
      `No active WhatsApp connection resolved for shop ${shopId}.`,
      'WHATSAPP_CONNECTION_NOT_RESOLVED',
      422,
    );
    this.name = 'WhatsAppConnectionNotResolvedError';
  }
}

export class InvalidInboundEventError extends DomainError {
  constructor(reason: string) {
    super(`Invalid inbound event: ${reason}`, 'INVALID_INBOUND_EVENT', 400);
    this.name = 'InvalidInboundEventError';
  }
}

export class InvalidPhoneNumberError extends DomainError {
  constructor() {
    super('Invalid phone number.', 'INVALID_PHONE_NUMBER', 400);
    this.name = 'InvalidPhoneNumberError';
  }
}

export class ContactNotFoundError extends DomainError {
  constructor() {
    super('Contact not found.', 'CONTACT_NOT_FOUND', 404);
    this.name = 'ContactNotFoundError';
  }
}

export class ConversationNotFoundError extends DomainError {
  constructor() {
    super('Conversation not found.', 'CONVERSATION_NOT_FOUND', 404);
    this.name = 'ConversationNotFoundError';
  }
}

export class MessageNotFoundError extends DomainError {
  constructor() {
    super('Message not found.', 'MESSAGE_NOT_FOUND', 404);
    this.name = 'MessageNotFoundError';
  }
}

/** Couvre toutes les transitions invalides, y compris "déjà dans cet état". */
export class InvalidConversationStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Invalid conversation status transition: ${from} -> ${to}.`,
      'INVALID_CONVERSATION_STATUS_TRANSITION',
      409,
    );
    this.name = 'InvalidConversationStatusTransitionError';
  }
}

/**
 * Répondre dans une conversation RESOLVED ou CLOSED est interdit :
 * une RESOLVED doit être rouverte manuellement d'abord ; une CLOSED est
 * terminale (le prochain message entrant créera une nouvelle conversation).
 */
export class ConversationClosedError extends DomainError {
  constructor() {
    super(
      'This conversation is resolved or closed. Reopen it before replying.',
      'CONVERSATION_CLOSED',
      409,
    );
    this.name = 'ConversationClosedError';
  }
}

/**
 * Fenêtre de service client WhatsApp (24 h après le dernier message entrant)
 * expirée : les messages libres sont refusés — seuls les templates approuvés
 * seront autorisés (phase Meta Cloud, hors périmètre actuel).
 */
export class CustomerServiceWindowExpiredError extends DomainError {
  constructor() {
    super(
      'The 24-hour customer service window has expired.',
      'CUSTOMER_SERVICE_WINDOW_EXPIRED',
      422,
    );
    this.name = 'CustomerServiceWindowExpiredError';
  }
}

/** 404 pour un membership cible inexistant OU d'une autre organisation (anti-énumération). */
export class AssigneeMembershipNotFoundError extends DomainError {
  constructor() {
    super('Membership not found.', 'ASSIGNEE_MEMBERSHIP_NOT_FOUND', 404);
    this.name = 'AssigneeMembershipNotFoundError';
  }
}

/** Le membership existe mais n'est pas assignable (LEFT ou SUSPENDED). */
export class MembershipNotAssignableError extends DomainError {
  constructor() {
    super(
      'This member is not active and cannot be assigned.',
      'MEMBERSHIP_NOT_ASSIGNABLE',
      409,
    );
    this.name = 'MembershipNotAssignableError';
  }
}

export class TagNotFoundError extends DomainError {
  constructor() {
    super('Tag not found.', 'TAG_NOT_FOUND', 404);
    this.name = 'TagNotFoundError';
  }
}

/** Seul un message FAILED peut être retenté, via l'endpoint retry explicite. */
export class MessageNotRetryableError extends DomainError {
  constructor(status: string) {
    super(
      `Only FAILED messages can be retried (current status: ${status}).`,
      'MESSAGE_NOT_RETRYABLE',
      409,
    );
    this.name = 'MessageNotRetryableError';
  }
}
