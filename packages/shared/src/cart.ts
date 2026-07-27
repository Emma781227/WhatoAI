/**
 * Fonctions pures du panier conversationnel — source unique partagée par
 * l'API, le worker et le frontend. Types en littéraux (pas d'import Prisma).
 */

import { PRICE_MINOR_MAX } from './catalog';

export const CART_OPEN_STATUSES = ['ACTIVE', 'CHECKOUT_STARTED'] as const;

export type CartStatusValue = 'ACTIVE' | 'CHECKOUT_STARTED' | 'CONVERTED' | 'ABANDONED' | 'EXPIRED';

/**
 * Table centrale des transitions Cart (5 statuts — décision validée, pas de
 * RESERVED : l'état de réservation vit dans StockReservation + CheckoutSession).
 */
export const CART_TRANSITIONS: Readonly<Record<CartStatusValue, readonly CartStatusValue[]>> = {
  ACTIVE: ['CHECKOUT_STARTED', 'ABANDONED', 'EXPIRED'],
  CHECKOUT_STARTED: ['ACTIVE', 'CONVERTED', 'ABANDONED', 'EXPIRED'],
  CONVERTED: [],
  ABANDONED: [],
  EXPIRED: [],
};

export function isCartTransitionAllowed(from: CartStatusValue, to: CartStatusValue): boolean {
  return CART_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------- totaux

export interface CartLineForTotals {
  unitPriceMinor: number;
  quantity: number;
}

export interface CartTotals {
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  /** Somme des quantités (badge UI). */
  itemCount: number;
}

/**
 * Totaux TOUJOURS calculés serveur — aucun montant du frontend n'est fiable.
 * Dépassements d'Int contrôlés ligne par ligne et sur l'accumulation.
 * @throws RangeError si un montant dépasse PRICE_MINOR_MAX.
 */
export function computeCartTotals(
  lines: CartLineForTotals[],
  options: { discountMinor?: number; deliveryFeeMinor?: number } = {},
): CartTotals {
  const discountMinor = options.discountMinor ?? 0;
  const deliveryFeeMinor = options.deliveryFeeMinor ?? 0;

  let subtotalMinor = 0;
  let itemCount = 0;
  for (const line of lines) {
    const lineSubtotal = line.unitPriceMinor * line.quantity;
    if (!Number.isSafeInteger(lineSubtotal) || lineSubtotal > PRICE_MINOR_MAX) {
      throw new RangeError('Cart line subtotal exceeds the maximum representable amount.');
    }
    subtotalMinor += lineSubtotal;
    if (subtotalMinor > PRICE_MINOR_MAX) {
      throw new RangeError('Cart subtotal exceeds the maximum representable amount.');
    }
    itemCount += line.quantity;
  }

  const totalMinor = subtotalMinor - discountMinor + deliveryFeeMinor;
  if (totalMinor < 0 || totalMinor > PRICE_MINOR_MAX) {
    throw new RangeError('Cart total is out of the representable range.');
  }
  return { subtotalMinor, discountMinor, deliveryFeeMinor, totalMinor, itemCount };
}

export function computeLineSubtotal(unitPriceMinor: number, quantity: number): number {
  const lineSubtotal = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(lineSubtotal) || lineSubtotal > PRICE_MINOR_MAX) {
    throw new RangeError('Cart line subtotal exceeds the maximum representable amount.');
  }
  return lineSubtotal;
}

// ---------------------------------------------------------------- revalidation

export type CartLineAvailability =
  | 'VALID'
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'QUANTITY_REDUCED_REQUIRED'
  | 'PRODUCT_UNAVAILABLE'
  | 'VARIANT_UNAVAILABLE';

export interface LineRevalidationInput {
  productStatus: string;
  variantStatus: string;
  /** Prix figé dans la ligne (snapshot). */
  snapshotUnitPriceMinor: number;
  /** Prix catalogue actuel. */
  currentPriceMinor: number;
  quantity: number;
  trackInventory: boolean;
  allowBackorder: boolean;
  quantityOnHand: number;
  quantityReserved: number;
  /**
   * Quantité déjà réservée par CE panier pour cette ligne (réservation
   * ACTIVE) : exclue du "déjà pris" — sinon un panier réservé se verrait
   * lui-même en rupture.
   */
  reservedByThisLine?: number;
}

export interface LineRevalidationResult {
  status: CartLineAvailability;
  currentPriceMinor: number;
  /** Renseigné pour QUANTITY_REDUCED_REQUIRED : maximum réservable. */
  maxQuantity?: number;
}

/**
 * Résultat de revalidation d'une ligne — priorités : disponibilité produit >
 * variante > prix > stock. Un PRICE_CHANGED n'est JAMAIS résolu
 * silencieusement (action explicite accept-current-price).
 */
export function revalidateCartLine(input: LineRevalidationInput): LineRevalidationResult {
  const base = { currentPriceMinor: input.currentPriceMinor };
  if (input.productStatus !== 'ACTIVE') {
    return { ...base, status: 'PRODUCT_UNAVAILABLE' };
  }
  if (input.variantStatus !== 'ACTIVE') {
    return { ...base, status: 'VARIANT_UNAVAILABLE' };
  }
  if (input.currentPriceMinor !== input.snapshotUnitPriceMinor) {
    return { ...base, status: 'PRICE_CHANGED' };
  }
  if (!input.trackInventory || input.allowBackorder) {
    return { ...base, status: 'VALID' };
  }
  const availableForThisLine =
    input.quantityOnHand - input.quantityReserved + (input.reservedByThisLine ?? 0);
  if (availableForThisLine <= 0) {
    return { ...base, status: 'OUT_OF_STOCK' };
  }
  if (availableForThisLine < input.quantity) {
    return { ...base, status: 'QUANTITY_REDUCED_REQUIRED', maxQuantity: availableForThisLine };
  }
  return { ...base, status: 'VALID' };
}

// ---------------------------------------------------------------- checkout

export type FulfillmentTypeValue = 'DELIVERY' | 'PICKUP';

export interface CheckoutInfoInput {
  fulfillmentType: FulfillmentTypeValue | null;
  customerName: string | null;
  customerPhone: string | null;
  city: string | null;
  addressLine1: string | null;
  landmark: string | null;
  countryCode: string | null;
}

/**
 * Champs manquants pour confirmer selon le fulfillment (validé §13) :
 * PICKUP = nom + téléphone ; DELIVERY = nom + téléphone + ville +
 * (adresse OU repère) + pays. postalCode JAMAIS obligatoire (Cameroun).
 */
export function missingCheckoutFields(input: CheckoutInfoInput): string[] {
  const missing: string[] = [];
  const has = (value: string | null): boolean => value !== null && value.trim() !== '';

  if (input.fulfillmentType === null) {
    missing.push('fulfillmentType');
  }
  if (!has(input.customerName)) {
    missing.push('customerName');
  }
  if (!has(input.customerPhone)) {
    missing.push('customerPhone');
  }
  if (input.fulfillmentType === 'DELIVERY') {
    if (!has(input.city)) {
      missing.push('city');
    }
    if (!has(input.addressLine1) && !has(input.landmark)) {
      missing.push('addressLine1|landmark');
    }
    if (!has(input.countryCode)) {
      missing.push('countryCode');
    }
  }
  return missing;
}

// ---------------------------------------------------------------- résumé

export interface CartSummaryLine {
  productName: string;
  variantName: string | null;
  quantity: number;
  lineSubtotalMinor: number;
}

/** Formatage monétaire serveur (Intl Node) — jamais de flottant stocké. */
export function formatMinorForSummary(minor: number, currency: string): string {
  try {
    const digits =
      new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(
      minor / 10 ** digits,
    );
  } catch {
    return `${minor} ${currency}`;
  }
}

/**
 * Texte de récapitulatif conversationnel (format validé §24). Généré côté
 * SERVEUR depuis un panier revalidé — l'agent l'insère, le modifie et
 * l'envoie explicitement ; jamais d'envoi automatique.
 */
export function buildCartSummaryText(input: {
  lines: CartSummaryLine[];
  currency: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  deliveryDecided: boolean;
}): string {
  const lines = input.lines.map((line) => {
    const label = line.variantName ? `${line.productName} — ${line.variantName}` : line.productName;
    return `- ${label} × ${line.quantity} : ${formatMinorForSummary(line.lineSubtotalMinor, input.currency)}`;
  });
  const delivery = input.deliveryDecided
    ? formatMinorForSummary(input.deliveryFeeMinor, input.currency)
    : 'à définir';
  return [
    'Votre panier :',
    '',
    ...lines,
    '',
    `Sous-total : ${formatMinorForSummary(input.subtotalMinor, input.currency)}`,
    `Livraison : ${delivery}`,
    `Total actuel : ${formatMinorForSummary(input.totalMinor, input.currency)}`,
  ].join('\n');
}
