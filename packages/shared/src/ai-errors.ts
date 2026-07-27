import { DomainError } from './errors';

/** 404 anti-énumération : configuration IA absente ou d'un autre tenant. */
export class AiConfigurationNotFoundError extends DomainError {
  constructor() {
    super('AI configuration not found.', 'AI_CONFIGURATION_NOT_FOUND', 404);
    this.name = 'AiConfigurationNotFoundError';
  }
}

/** 404 anti-énumération : suggestion inexistante ou hors périmètre. */
export class AiSuggestionNotFoundError extends DomainError {
  constructor() {
    super('AI suggestion not found.', 'AI_SUGGESTION_NOT_FOUND', 404);
    this.name = 'AiSuggestionNotFoundError';
  }
}

/** 409 : suggestion déjà acceptée/rejetée/expirée — une seule issue possible. */
export class AiSuggestionAlreadyHandledError extends DomainError {
  constructor() {
    super('AI suggestion already handled.', 'AI_SUGGESTION_ALREADY_HANDLED', 409);
    this.name = 'AiSuggestionAlreadyHandledError';
  }
}

/** 409 verrou optimiste : version attendue ≠ version courante. */
export class AiSuggestionVersionConflictError extends DomainError {
  constructor() {
    super('AI suggestion version conflict.', 'AI_SUGGESTION_VERSION_CONFLICT', 409);
    this.name = 'AiSuggestionVersionConflictError';
  }
}

/**
 * 409 : la conversation a évolué depuis la génération (nouveau message client,
 * réponse humaine, handoff ouvert, suggestion expirée). `canConfirm=true`
 * signale que l'agent peut forcer l'envoi via `confirmStale`.
 */
export class AiSuggestionStaleError extends DomainError {
  constructor() {
    super('AI suggestion is stale.', 'AI_SUGGESTION_STALE', 409, { canConfirm: true });
    this.name = 'AiSuggestionStaleError';
  }
}

/** 409 : un handoff humain est ouvert — l'IA ne génère plus. */
export class AiConversationInHandoffError extends DomainError {
  constructor() {
    super('Conversation is in human handoff.', 'AI_CONVERSATION_IN_HANDOFF', 409);
    this.name = 'AiConversationInHandoffError';
  }
}

/** 409 : l'IA est désactivée (globalement ou pour la Shop). */
export class AiDisabledError extends DomainError {
  constructor() {
    super('AI is disabled for this shop.', 'AI_DISABLED', 409);
    this.name = 'AiDisabledError';
  }
}

/** 409 verrou optimiste de configuration IA. */
export class AiConfigurationVersionConflictError extends DomainError {
  constructor() {
    super('AI configuration version conflict.', 'AI_CONFIGURATION_VERSION_CONFLICT', 409);
    this.name = 'AiConfigurationVersionConflictError';
  }
}
