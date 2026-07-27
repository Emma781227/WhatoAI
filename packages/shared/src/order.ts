import { formatMinorForSummary } from './cart';

// ============================================================================
// Module Orders — transitions, cohérence des trois statuts, numéro, résumé.
// SOURCE UNIQUE partagée API / frontend : aucune règle de transition ne vit
// ailleurs que dans ce fichier et le service de transition qui l'applique.
// ============================================================================

export type OrderStatusValue =
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'READY'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export type OrderPaymentStatusValue =
  | 'UNPAID'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

export type OrderFulfillmentStatusValue =
  | 'PENDING'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'READY_FOR_SHIPMENT'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'NOT_REQUIRED';

export type OrderFulfillmentTypeValue = 'DELIVERY' | 'PICKUP';

export type OrderPaymentPreferenceValue =
  | 'CASH_ON_DELIVERY'
  | 'MOBILE_MONEY'
  | 'CARD'
  | 'PAY_IN_STORE'
  | 'UNDECIDED';

/**
 * Table centrale des transitions OrderStatus (validé §11) :
 * - READY → DELIVERED réservé au PICKUP (contrôle contextuel dans
 *   `isOrderTransitionAllowed`, la table liste le maximum autorisé) ;
 * - SHIPPED → CANCELLED refusé dans cette phase (workflow retour hors scope) ;
 * - DELIVERED et CANCELLED terminaux.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatusValue, readonly OrderStatusValue[]>
> = {
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY', 'CANCELLED'],
  READY: ['SHIPPED', 'DELIVERED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Transition valide compte tenu du type de fulfillment. */
export function isOrderTransitionAllowed(
  from: OrderStatusValue,
  to: OrderStatusValue,
  fulfillmentType: OrderFulfillmentTypeValue,
): boolean {
  if (!ORDER_STATUS_TRANSITIONS[from].includes(to)) {
    return false;
  }
  // READY → DELIVERED : retrait en boutique uniquement ; une livraison passe
  // par SHIPPED. READY → SHIPPED n'a pas de sens en retrait.
  if (from === 'READY' && to === 'DELIVERED' && fulfillmentType !== 'PICKUP') {
    return false;
  }
  if (from === 'READY' && to === 'SHIPPED' && fulfillmentType !== 'DELIVERY') {
    return false;
  }
  return true;
}

/** Statuts depuis lesquels l'annulation avec restitution est autorisée (validé D9). */
export const ORDER_CANCELLABLE_STATUSES: readonly OrderStatusValue[] = [
  'CONFIRMED',
  'PROCESSING',
  'READY',
];

/**
 * Mapping initial paymentPreference → paymentStatus (validé — ajustement 12).
 * Aucun passage automatique à PAID dans cette phase.
 */
export function initialPaymentStatus(
  preference: OrderPaymentPreferenceValue,
): OrderPaymentStatusValue {
  switch (preference) {
    case 'MOBILE_MONEY':
    case 'CARD':
      return 'PENDING';
    case 'CASH_ON_DELIVERY':
    case 'PAY_IN_STORE':
    case 'UNDECIDED':
      return 'UNPAID';
  }
}

/**
 * Fulfillment initial (validé D5 + ajustement 6) : NOT_REQUIRED seulement si
 * TOUTES les lignes sont SERVICE/DIGITAL — déterminé depuis les
 * productTypeSnapshot du confirmationSnapshot, JAMAIS depuis le catalogue.
 */
export function initialFulfillmentStatus(
  lineProductTypes: readonly string[],
): OrderFulfillmentStatusValue {
  const allImmaterial =
    lineProductTypes.length > 0 &&
    lineProductTypes.every((type) => type === 'SERVICE' || type === 'DIGITAL');
  return allImmaterial ? 'NOT_REQUIRED' : 'PENDING';
}

/**
 * Effet dérivé SYSTEM d'une transition OrderStatus sur le fulfillment
 * (service de transition centralisé — validé §14). NOT_REQUIRED n'est jamais
 * modifié, sauf annulation où il est conservé tel quel.
 */
export function derivedFulfillmentStatus(
  orderStatus: OrderStatusValue,
  fulfillmentType: OrderFulfillmentTypeValue,
  current: OrderFulfillmentStatusValue,
): OrderFulfillmentStatusValue {
  if (current === 'NOT_REQUIRED') {
    return 'NOT_REQUIRED';
  }
  switch (orderStatus) {
    case 'PROCESSING':
      return 'PREPARING';
    case 'READY':
      return fulfillmentType === 'PICKUP' ? 'READY_FOR_PICKUP' : 'READY_FOR_SHIPMENT';
    case 'SHIPPED':
      return 'IN_TRANSIT';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'CONFIRMED':
      return current;
  }
}

/**
 * DELIVERED exige un paiement résolu OU un encaissement hors ligne assumé
 * (validé §14 + ajustement 18) : UNPAID accepté uniquement pour
 * CASH_ON_DELIVERY / PAY_IN_STORE — l'UI affiche « paiement à encaisser ».
 */
export function canDeliverWithPayment(
  paymentStatus: OrderPaymentStatusValue,
  paymentPreference: OrderPaymentPreferenceValue,
): boolean {
  if (paymentStatus === 'PAID') {
    return true;
  }
  return (
    paymentStatus === 'UNPAID' &&
    (paymentPreference === 'CASH_ON_DELIVERY' || paymentPreference === 'PAY_IN_STORE')
  );
}

/** Paiement restant à encaisser à la livraison (bandeau d'avertissement UI). */
export function isPaymentToCollect(
  paymentStatus: OrderPaymentStatusValue,
  paymentPreference: OrderPaymentPreferenceValue,
): boolean {
  return (
    paymentStatus === 'UNPAID' &&
    (paymentPreference === 'CASH_ON_DELIVERY' || paymentPreference === 'PAY_IN_STORE')
  );
}

// ------------------------------------------------------------- numéro

export const ORDER_NUMBER_PREFIX_MAX_LENGTH = 8;
export const ORDER_NUMBER_PREFIX_FALLBACK = 'WHA';

/**
 * Dérive un CANDIDAT de préfixe depuis un slug — utilisé une seule fois à la
 * génération initiale du préfixe stable d'une Shop (le service unicifie
 * ensuite avec un suffixe numérique si le candidat est pris, insensible à la
 * casse). Le préfixe stocké ne change JAMAIS avec le slug (validé — ajust. 1).
 */
export function deriveOrderNumberPrefixCandidate(slug: string): string {
  const cleaned = slug.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, ORDER_NUMBER_PREFIX_MAX_LENGTH) || ORDER_NUMBER_PREFIX_FALLBACK;
}

/** PREFIX-YYYY-NNNNNN */
export function formatOrderNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

// ------------------------------------------------------------- résumé

export interface OrderSummaryLine {
  productName: string;
  variantName: string | null;
  quantity: number;
  lineSubtotalMinor: number;
}

const ORDER_STATUS_SUMMARY_LABELS: Record<OrderStatusValue, string> = {
  CONFIRMED: 'confirmée',
  PROCESSING: 'en préparation',
  READY: 'prête',
  SHIPPED: 'expédiée',
  DELIVERED: 'livrée',
  CANCELLED: 'annulée',
};

const PAYMENT_PREFERENCE_SUMMARY_LABELS: Record<OrderPaymentPreferenceValue, string> = {
  CASH_ON_DELIVERY: 'À la livraison',
  MOBILE_MONEY: 'Mobile Money',
  CARD: 'Carte bancaire',
  PAY_IN_STORE: 'En boutique',
  UNDECIDED: 'À définir',
};

/** Texte serveur inséré dans le composer par l'agent — jamais envoyé automatiquement. */
export function buildOrderSummaryText(input: {
  orderNumber: string;
  status: OrderStatusValue;
  lines: readonly OrderSummaryLine[];
  currency: string;
  totalMinor: number;
  deliveryFeeMinor: number;
  fulfillmentType: OrderFulfillmentTypeValue;
  city: string | null;
  landmark: string | null;
  paymentPreference: OrderPaymentPreferenceValue;
}): string {
  const lines = input.lines.map((line) => {
    const label = line.variantName
      ? `${line.productName} — ${line.variantName}`
      : line.productName;
    return `- ${label} × ${line.quantity} : ${formatMinorForSummary(line.lineSubtotalMinor, input.currency)}`;
  });
  const fulfillment =
    input.fulfillmentType === 'PICKUP'
      ? 'Retrait en boutique'
      : `Livraison : ${[input.city, input.landmark].filter(Boolean).join(', ') || 'adresse enregistrée'}`;
  return [
    `Commande ${input.orderNumber} ${ORDER_STATUS_SUMMARY_LABELS[input.status]}`,
    '',
    ...lines,
    '',
    `Total : ${formatMinorForSummary(input.totalMinor, input.currency)}`,
    fulfillment,
    `Paiement : ${PAYMENT_PREFERENCE_SUMMARY_LABELS[input.paymentPreference]}`,
  ].join('\n');
}
