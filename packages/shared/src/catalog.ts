/**
 * Fonctions pures du catalogue — source unique partagée par l'API, le worker
 * et le frontend. Types en littéraux (pas d'import Prisma).
 */

// ---------------------------------------------------------------- montants

/**
 * Montants en unité mineure entière (Int PostgreSQL 4 octets) :
 * XAF 5000 = 5 000 XAF ; EUR 1299 = 12,99 EUR.
 * Limite documentée : 2 147 483 647 unités mineures (~2,1 Md XAF / ~21 M EUR
 * par ligne) — largement suffisant pour le commerce de détail V1.
 * JAMAIS de Float/Decimal pour l'argent.
 */
export const PRICE_MINOR_MAX = 2_147_483_647;

export function isValidPriceMinor(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= PRICE_MINOR_MAX;
}

// ---------------------------------------------------------------- SKU / barcode

/**
 * SKU stocké NORMALISÉ : trim + MAJUSCULES — l'unicité par Shop devient
 * insensible à la casse par construction ("SKU-001" ≡ "sku-001").
 * Format strict : alphanumérique + . _ / -, 1 à 50 caractères, commence par
 * un alphanumérique. Retourne null si invalide.
 */
export function normalizeSku(raw: string): string | null {
  const sku = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(sku) ? sku : null;
}

/** Même convention pour le barcode (EAN/UPC/code interne) : 4 à 50 caractères. */
export function normalizeBarcode(raw: string): string | null {
  const barcode = raw.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{3,49}$/.test(barcode) ? barcode : null;
}

// ---------------------------------------------------------------- combinaisons

export const DEFAULT_COMBINATION_KEY = 'DEFAULT';

export interface CombinationPair {
  optionName: string;
  value: string;
}

/** Normalisation canonique d'un libellé d'option/valeur : trim, espaces réduits, minuscules. */
export function normalizeCombinationToken(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Clé de combinaison CANONIQUE d'une variante — fondée sur les NOMS d'options
 * et de valeurs normalisés (jamais des ids techniques), triés de manière
 * déterministe par nom d'option. Exemple :
 *   [{Taille:M},{Couleur:Rouge}] → '[["couleur","rouge"],["taille","m"]]'
 * Une variante sans options (produit simple) → 'DEFAULT'.
 * Protégée en base par l'index unique partiel
 * product_variants_unique_combination_per_product.
 */
export function buildCombinationKey(pairs: CombinationPair[]): string {
  if (pairs.length === 0) {
    return DEFAULT_COMBINATION_KEY;
  }
  const normalized = pairs
    .map((pair) => [normalizeCombinationToken(pair.optionName), normalizeCombinationToken(pair.value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(normalized);
}

// ---------------------------------------------------------------- stock

export type StockStatus =
  | 'IN_STOCK'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK'
  | 'NOT_TRACKED'
  | 'BACKORDERED';

export interface VariantStockInput {
  trackInventory: boolean;
  allowBackorder: boolean;
  quantityOnHand: number;
  quantityReserved: number;
  lowStockThreshold: number;
}

/**
 * quantityAvailable = onHand − reserved. TOUJOURS calculé, jamais stocké.
 * Peut être négatif : onHand ne descend jamais sous 0 (CHECK SQL), c'est
 * reserved qui peut dépasser onHand quand allowBackorder=true.
 */
export function computeQuantityAvailable(input: {
  quantityOnHand: number;
  quantityReserved: number;
}): number {
  return input.quantityOnHand - input.quantityReserved;
}

/** État de stock d'une VARIANTE — règles validées (§13). */
export function computeVariantStockStatus(input: VariantStockInput): StockStatus {
  if (!input.trackInventory) {
    return 'NOT_TRACKED';
  }
  const available = computeQuantityAvailable(input);
  if (available <= 0) {
    return input.allowBackorder ? 'BACKORDERED' : 'OUT_OF_STOCK';
  }
  if (available <= input.lowStockThreshold) {
    return 'LOW_STOCK';
  }
  return 'IN_STOCK';
}

/**
 * État de stock d'un PRODUIT = meilleure disponibilité parmi ses variantes
 * vendables suivies ("puis-je vendre ce produit ?") :
 * IN_STOCK > LOW_STOCK > BACKORDERED > OUT_OF_STOCK ; NOT_TRACKED si aucune
 * variante suivie. Les alertes par variante vivent sur la page Inventory.
 * L'équivalent SQL (CTE de la liste produits) DOIT rester aligné — testé e2e.
 */
export function aggregateProductStockStatus(variantStatuses: StockStatus[]): StockStatus {
  const tracked = variantStatuses.filter((status) => status !== 'NOT_TRACKED');
  if (tracked.length === 0) {
    return 'NOT_TRACKED';
  }
  for (const status of ['IN_STOCK', 'LOW_STOCK', 'BACKORDERED'] as const) {
    if (tracked.includes(status)) {
      return status;
    }
  }
  return 'OUT_OF_STOCK';
}
