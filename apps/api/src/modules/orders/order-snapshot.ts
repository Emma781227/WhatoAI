import { OrderSnapshotInvalidError } from '@whauto/shared';

/**
 * Parse DÉFENSIF du confirmationSnapshot stocké dans CheckoutSession —
 * l'UNIQUE source d'entrée de la conversion (jamais un snapshot fourni par le
 * frontend, jamais le catalogue courant). Les champs ajoutés par
 * l'enrichissement (ajustement 3) sont requis pour convertir : un snapshot
 * antérieur incomplet est refusé explicitement (aucun fallback commercial —
 * ajustement 4), il faut re-confirmer le checkout.
 */

export interface SnapshotLine {
  cartItemId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  imageUrl: string | null;
  optionValues: unknown;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  quantity: number;
  lineSubtotalMinor: number;
  productType: 'PHYSICAL' | 'SERVICE' | 'DIGITAL';
  trackInventory: boolean;
  allowBackorder: boolean;
}

export interface ConfirmationSnapshot {
  cartId: string;
  checkoutSessionId: string;
  conversationId: string;
  contactId: string;
  shopId: string;
  organizationId: string;
  currency: string;
  confirmedAt: string;
  cartVersion: number;
  checkoutVersion: number;
  lines: SnapshotLine[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  fulfillmentType: 'DELIVERY' | 'PICKUP' | null;
  customer: { name: string | null; phone: string; email: string | null };
  address: {
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
    landmark: string | null;
  };
  deliveryInstructions: string | null;
  paymentPreference: 'CASH_ON_DELIVERY' | 'MOBILE_MONEY' | 'CARD' | 'PAY_IN_STORE' | 'UNDECIDED';
  reservations: Array<{ id: string; cartItemId: string; quantity: number; expiresAt: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OrderSnapshotInvalidError(`missing or invalid ${path}.${key}`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireInt(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OrderSnapshotInvalidError(`missing or invalid ${path}.${key}`);
  }
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw new OrderSnapshotInvalidError(`missing or invalid ${path}.${key}`);
  }
  return value;
}

const PRODUCT_TYPES = ['PHYSICAL', 'SERVICE', 'DIGITAL'] as const;
const PAYMENT_PREFERENCES = [
  'CASH_ON_DELIVERY',
  'MOBILE_MONEY',
  'CARD',
  'PAY_IN_STORE',
  'UNDECIDED',
] as const;

export function parseConfirmationSnapshot(raw: unknown): ConfirmationSnapshot {
  if (!isRecord(raw)) {
    throw new OrderSnapshotInvalidError('snapshot is not an object');
  }
  const linesRaw = raw['lines'];
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) {
    throw new OrderSnapshotInvalidError('snapshot has no lines');
  }
  const customerRaw = raw['customer'];
  const addressRaw = raw['address'];
  if (!isRecord(customerRaw) || !isRecord(addressRaw)) {
    throw new OrderSnapshotInvalidError('missing customer or address block');
  }
  const fulfillmentType = raw['fulfillmentType'];
  if (fulfillmentType !== 'DELIVERY' && fulfillmentType !== 'PICKUP') {
    throw new OrderSnapshotInvalidError('missing or invalid fulfillmentType');
  }
  const paymentPreference = raw['paymentPreference'];
  if (!PAYMENT_PREFERENCES.includes(paymentPreference as (typeof PAYMENT_PREFERENCES)[number])) {
    throw new OrderSnapshotInvalidError('missing or invalid paymentPreference');
  }
  const reservationsRaw = Array.isArray(raw['reservations']) ? raw['reservations'] : [];

  const lines: SnapshotLine[] = linesRaw.map((lineRaw, index) => {
    if (!isRecord(lineRaw)) {
      throw new OrderSnapshotInvalidError(`line ${index} is not an object`);
    }
    const path = `lines[${index}]`;
    const productType = lineRaw['productType'];
    if (!PRODUCT_TYPES.includes(productType as (typeof PRODUCT_TYPES)[number])) {
      throw new OrderSnapshotInvalidError(
        `missing or invalid ${path}.productType — re-confirm the checkout with the current version`,
      );
    }
    const quantity = requireInt(lineRaw, 'quantity', path);
    if (quantity === 0) {
      throw new OrderSnapshotInvalidError(`${path}.quantity must be positive`);
    }
    const unitPriceMinor = requireInt(lineRaw, 'unitPriceMinor', path);
    const lineSubtotalMinor = requireInt(lineRaw, 'lineSubtotalMinor', path);
    if (lineSubtotalMinor !== unitPriceMinor * quantity) {
      throw new OrderSnapshotInvalidError(`${path}.lineSubtotalMinor is inconsistent`);
    }
    const compareAtRaw = lineRaw['compareAtPriceMinor'];
    return {
      cartItemId: requireString(lineRaw, 'cartItemId', path),
      productId: requireString(lineRaw, 'productId', path),
      variantId: requireString(lineRaw, 'variantId', path),
      productName: requireString(lineRaw, 'productName', path),
      variantName: optionalString(lineRaw, 'variantName'),
      sku: requireString(lineRaw, 'sku', path),
      imageUrl: optionalString(lineRaw, 'imageUrl'),
      optionValues: lineRaw['optionValues'] ?? null,
      unitPriceMinor,
      compareAtPriceMinor:
        typeof compareAtRaw === 'number' && Number.isInteger(compareAtRaw) ? compareAtRaw : null,
      quantity,
      lineSubtotalMinor,
      productType: productType as SnapshotLine['productType'],
      trackInventory: requireBoolean(lineRaw, 'trackInventory', path),
      allowBackorder: requireBoolean(lineRaw, 'allowBackorder', path),
    };
  });

  const subtotalMinor = requireInt(raw, 'subtotalMinor', 'snapshot');
  const discountMinor = requireInt(raw, 'discountMinor', 'snapshot');
  const deliveryFeeMinor = requireInt(raw, 'deliveryFeeMinor', 'snapshot');
  const totalMinor = requireInt(raw, 'totalMinor', 'snapshot');
  if (totalMinor !== subtotalMinor - discountMinor + deliveryFeeMinor) {
    throw new OrderSnapshotInvalidError('snapshot totals are inconsistent');
  }
  const linesSum = lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
  if (linesSum !== subtotalMinor) {
    throw new OrderSnapshotInvalidError('snapshot subtotal does not match its lines');
  }

  return {
    cartId: requireString(raw, 'cartId', 'snapshot'),
    checkoutSessionId: requireString(raw, 'checkoutSessionId', 'snapshot'),
    conversationId: requireString(raw, 'conversationId', 'snapshot'),
    contactId: requireString(raw, 'contactId', 'snapshot'),
    shopId: requireString(raw, 'shopId', 'snapshot'),
    organizationId: requireString(raw, 'organizationId', 'snapshot'),
    currency: requireString(raw, 'currency', 'snapshot'),
    confirmedAt: requireString(raw, 'confirmedAt', 'snapshot'),
    cartVersion: requireInt(raw, 'cartVersion', 'snapshot'),
    checkoutVersion: requireInt(raw, 'checkoutVersion', 'snapshot'),
    lines,
    subtotalMinor,
    discountMinor,
    deliveryFeeMinor,
    totalMinor,
    fulfillmentType,
    customer: {
      name: optionalString(customerRaw, 'name'),
      phone: requireString(customerRaw, 'phone', 'customer'),
      email: optionalString(customerRaw, 'email'),
    },
    address: {
      addressLine1: optionalString(addressRaw, 'addressLine1'),
      addressLine2: optionalString(addressRaw, 'addressLine2'),
      city: optionalString(addressRaw, 'city'),
      region: optionalString(addressRaw, 'region'),
      postalCode: optionalString(addressRaw, 'postalCode'),
      countryCode: optionalString(addressRaw, 'countryCode'),
      landmark: optionalString(addressRaw, 'landmark'),
    },
    deliveryInstructions: optionalString(raw, 'deliveryInstructions'),
    paymentPreference: paymentPreference as ConfirmationSnapshot['paymentPreference'],
    reservations: reservationsRaw.filter(isRecord).map((row, index) => ({
      id: requireString(row, 'id', `reservations[${index}]`),
      cartItemId: requireString(row, 'cartItemId', `reservations[${index}]`),
      quantity: requireInt(row, 'quantity', `reservations[${index}]`),
      expiresAt: requireString(row, 'expiresAt', `reservations[${index}]`),
    })),
  };
}
