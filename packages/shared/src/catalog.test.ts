import { describe, expect, it } from 'vitest';

import {
  aggregateProductStockStatus,
  buildCombinationKey,
  computeQuantityAvailable,
  computeVariantStockStatus,
  DEFAULT_COMBINATION_KEY,
  isValidPriceMinor,
  normalizeBarcode,
  normalizeSku,
  PRICE_MINOR_MAX,
} from './catalog';

describe('isValidPriceMinor', () => {
  it('accepte les entiers de 0 à la limite documentée', () => {
    expect(isValidPriceMinor(0)).toBe(true);
    expect(isValidPriceMinor(5000)).toBe(true);
    expect(isValidPriceMinor(PRICE_MINOR_MAX)).toBe(true);
  });

  it('refuse négatifs, flottants et dépassements', () => {
    expect(isValidPriceMinor(-1)).toBe(false);
    expect(isValidPriceMinor(12.99)).toBe(false);
    expect(isValidPriceMinor(PRICE_MINOR_MAX + 1)).toBe(false);
  });
});

describe('normalizeSku — unicité insensible à la casse par construction', () => {
  it('trim + majuscules : SKU-001 et sku-001 deviennent identiques', () => {
    expect(normalizeSku('  sku-001 ')).toBe('SKU-001');
    expect(normalizeSku('SKU-001')).toBe('SKU-001');
    expect(normalizeSku('sku-001')).toBe(normalizeSku('SKU-001'));
  });

  it('accepte le format strict (alphanumérique + . _ / -)', () => {
    expect(normalizeSku('tee.m_rouge/2026')).toBe('TEE.M_ROUGE/2026');
  });

  it('refuse vide, caractère initial non alphanumérique, symboles et > 50 caractères', () => {
    expect(normalizeSku('')).toBeNull();
    expect(normalizeSku('-abc')).toBeNull();
    expect(normalizeSku('SKU 001')).toBeNull();
    expect(normalizeSku('SKU#1')).toBeNull();
    expect(normalizeSku('A'.repeat(51))).toBeNull();
  });
});

describe('normalizeBarcode', () => {
  it('normalise et valide (4-50, alphanumérique + tiret)', () => {
    expect(normalizeBarcode(' 3760001234567 ')).toBe('3760001234567');
    expect(normalizeBarcode('ean-13')).toBe('EAN-13');
    expect(normalizeBarcode('abc')).toBeNull();
    expect(normalizeBarcode('a b c d')).toBeNull();
  });
});

describe('buildCombinationKey — représentation canonique (jamais des ids)', () => {
  it('produit simple sans options → DEFAULT', () => {
    expect(buildCombinationKey([])).toBe(DEFAULT_COMBINATION_KEY);
  });

  it('fondée sur les noms normalisés (trim, espaces réduits, minuscules)', () => {
    expect(buildCombinationKey([{ optionName: '  Couleur ', value: ' Rouge  Vif ' }])).toBe(
      '[["couleur","rouge vif"]]',
    );
  });

  it('STABLE quel que soit l’ordre des options fourni', () => {
    const a = buildCombinationKey([
      { optionName: 'Taille', value: 'M' },
      { optionName: 'Couleur', value: 'Rouge' },
    ]);
    const b = buildCombinationKey([
      { optionName: 'couleur', value: 'ROUGE' },
      { optionName: 'taille', value: 'm' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('[["couleur","rouge"],["taille","m"]]');
  });

  it('deux combinaisons différentes produisent des clés différentes', () => {
    const rougeM = buildCombinationKey([
      { optionName: 'Taille', value: 'M' },
      { optionName: 'Couleur', value: 'Rouge' },
    ]);
    const bleuM = buildCombinationKey([
      { optionName: 'Taille', value: 'M' },
      { optionName: 'Couleur', value: 'Bleu' },
    ]);
    expect(rougeM).not.toBe(bleuM);
  });
});

describe('computeVariantStockStatus (§13 validé)', () => {
  const base = {
    trackInventory: true,
    allowBackorder: false,
    quantityOnHand: 10,
    quantityReserved: 0,
    lowStockThreshold: 5,
  };

  it('NOT_TRACKED si trackInventory=false, quel que soit le stock', () => {
    expect(computeVariantStockStatus({ ...base, trackInventory: false, quantityOnHand: 0 })).toBe(
      'NOT_TRACKED',
    );
  });

  it('OUT_OF_STOCK si available <= 0 sans backorder', () => {
    expect(computeVariantStockStatus({ ...base, quantityOnHand: 0 })).toBe('OUT_OF_STOCK');
    expect(computeVariantStockStatus({ ...base, quantityOnHand: 3, quantityReserved: 3 })).toBe(
      'OUT_OF_STOCK',
    );
  });

  it('BACKORDERED si available <= 0 avec backorder — available négatif SANS stock physique négatif', () => {
    const input = { ...base, allowBackorder: true, quantityOnHand: 2, quantityReserved: 5 };
    expect(input.quantityOnHand).toBeGreaterThanOrEqual(0); // jamais négatif
    expect(computeQuantityAvailable(input)).toBe(-3); // available PEUT l'être
    expect(computeVariantStockStatus(input)).toBe('BACKORDERED');
  });

  it('LOW_STOCK si 0 < available <= seuil, IN_STOCK au-delà', () => {
    expect(computeVariantStockStatus({ ...base, quantityOnHand: 5 })).toBe('LOW_STOCK');
    expect(computeVariantStockStatus({ ...base, quantityOnHand: 6 })).toBe('IN_STOCK');
  });
});

describe('aggregateProductStockStatus — meilleure disponibilité', () => {
  it('NOT_TRACKED si aucune variante suivie', () => {
    expect(aggregateProductStockStatus([])).toBe('NOT_TRACKED');
    expect(aggregateProductStockStatus(['NOT_TRACKED', 'NOT_TRACKED'])).toBe('NOT_TRACKED');
  });

  it('priorité IN_STOCK > LOW_STOCK > BACKORDERED > OUT_OF_STOCK', () => {
    expect(aggregateProductStockStatus(['OUT_OF_STOCK', 'IN_STOCK', 'LOW_STOCK'])).toBe('IN_STOCK');
    expect(aggregateProductStockStatus(['OUT_OF_STOCK', 'LOW_STOCK'])).toBe('LOW_STOCK');
    expect(aggregateProductStockStatus(['OUT_OF_STOCK', 'BACKORDERED'])).toBe('BACKORDERED');
    expect(aggregateProductStockStatus(['OUT_OF_STOCK', 'OUT_OF_STOCK'])).toBe('OUT_OF_STOCK');
  });

  it('les variantes NOT_TRACKED sont ignorées quand d’autres sont suivies', () => {
    expect(aggregateProductStockStatus(['NOT_TRACKED', 'OUT_OF_STOCK'])).toBe('OUT_OF_STOCK');
  });
});
