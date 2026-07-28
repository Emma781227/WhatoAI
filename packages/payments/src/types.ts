/**
 * Contrat d'abstraction PaymentProvider — package PUR (aucune dépendance
 * NestJS/Prisma, AUCUNE lecture de `process.env` : toute config est INJECTÉE,
 * comme `@whauto/whatsapp`). L'agrégateur (Genius Pay, futur) ENCAISSE l'argent ;
 * le Wallet gère les crédits. Le provider ne connaît que des montants et des
 * références opaques — jamais la logique de crédits.
 */

export type PaymentProviderName = 'MOCK' | 'GENIUS_PAY';

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

/** Demande de paiement. `reference` = id du TopUp Whauto (opaque pour le provider). */
export interface PaymentRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  description?: string;
  returnUrl?: string;
  cancelUrl?: string;
  /** Métadonnées NON sensibles transmises au provider (jamais de secret). */
  metadata?: Record<string, string>;
}

/** Session de paiement créée côté agrégateur. */
export interface PaymentSession {
  provider: PaymentProviderName;
  providerPaymentId: string;
  status: PaymentStatus;
  /** URL de paiement (checkout). En MOCK : URL factice, jamais un vrai paiement. */
  checkoutUrl: string | null;
  reference: string;
}

/** Résultat d'une vérification de statut auprès du provider. */
export interface PaymentStatusResult {
  providerPaymentId: string;
  status: PaymentStatus;
  reference: string | null;
}

/** Événement de webhook paiement normalisé (jamais de signature/secret conservé). */
export interface PaymentWebhookEvent {
  providerPaymentId: string;
  status: PaymentStatus;
  reference: string | null;
}

/**
 * Config INJECTÉE du provider (jamais lue depuis l'environnement dans ce
 * package). Les vrais secrets Genius Pay ne vivent que dans `.env` de l'app, et
 * ne sont jamais loggés/exposés.
 */
export interface PaymentProviderConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  secretKey?: string;
  webhookSecret?: string;
  merchantId?: string;
  returnUrl?: string;
  cancelUrl?: string;
  requestTimeoutMs?: number;
}
