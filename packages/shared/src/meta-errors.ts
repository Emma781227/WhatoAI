import { DomainError } from './errors';

/** Vérification GET du webhook Meta échouée (hub.verify_token invalide). */
export class MetaWebhookVerificationError extends DomainError {
  constructor() {
    super('Webhook verification failed.', 'META_WEBHOOK_VERIFICATION_FAILED', 403);
    this.name = 'MetaWebhookVerificationError';
  }
}

/** Signature HMAC du webhook POST invalide ou absente — requête refusée. */
export class MetaWebhookSignatureError extends DomainError {
  constructor() {
    super('Invalid webhook signature.', 'META_WEBHOOK_SIGNATURE_INVALID', 401);
    this.name = 'MetaWebhookSignatureError';
  }
}

/** Corps de webhook absent ou illisible. */
export class MetaWebhookPayloadError extends DomainError {
  constructor() {
    super('Invalid webhook payload.', 'META_WEBHOOK_PAYLOAD_INVALID', 400);
    this.name = 'MetaWebhookPayloadError';
  }
}

/** Meta n'est pas configuré (variables d'environnement absentes). */
export class MetaChannelConfigurationError extends DomainError {
  constructor() {
    super(
      'The Meta WhatsApp integration is not configured.',
      'META_CHANNEL_CONFIGURATION_ERROR',
      409,
    );
    this.name = 'MetaChannelConfigurationError';
  }
}

/** Échec d'un appel technique à l'API Graph (health/test) — détail filtré, jamais de secret. */
export class MetaApiError extends DomainError {
  constructor(code: string) {
    super('Meta API call failed.', code, 502);
    this.name = 'MetaApiError';
  }
}
