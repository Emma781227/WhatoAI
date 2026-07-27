import { describe, expect, it } from 'vitest';

import {
  buildCartSummaryText,
  computeCartTotals,
  isCartTransitionAllowed,
  missingCheckoutFields,
  revalidateCartLine,
} from './cart';
import { PRICE_MINOR_MAX } from './catalog';

describe('computeCartTotals — serveur autoritaire', () => {
  it('somme des lignes + itemCount = somme des quantités', () => {
    const totals = computeCartTotals([
      { unitPriceMinor: 25000, quantity: 1 },
      { unitPriceMinor: 5000, quantity: 2 },
    ]);
    expect(totals).toMatchObject({ subtotalMinor: 35000, totalMinor: 35000, itemCount: 3 });
  });

  it('total = subtotal − discount + deliveryFee', () => {
    const totals = computeCartTotals([{ unitPriceMinor: 10000, quantity: 1 }], {
      discountMinor: 1000,
      deliveryFeeMinor: 1500,
    });
    expect(totals.totalMinor).toBe(10500);
  });

  it('dépassement d’Int refusé (ligne et accumulation)', () => {
    expect(() =>
      computeCartTotals([{ unitPriceMinor: PRICE_MINOR_MAX, quantity: 2 }]),
    ).toThrow(RangeError);
    expect(() =>
      computeCartTotals([
        { unitPriceMinor: PRICE_MINOR_MAX, quantity: 1 },
        { unitPriceMinor: 1, quantity: 1 },
      ]),
    ).toThrow(RangeError);
  });

  it('panier vide = totaux à zéro', () => {
    expect(computeCartTotals([])).toMatchObject({ subtotalMinor: 0, totalMinor: 0, itemCount: 0 });
  });
});

describe('revalidateCartLine — priorités et statuts', () => {
  const base = {
    productStatus: 'ACTIVE',
    variantStatus: 'ACTIVE',
    snapshotUnitPriceMinor: 5000,
    currentPriceMinor: 5000,
    quantity: 2,
    trackInventory: true,
    allowBackorder: false,
    quantityOnHand: 10,
    quantityReserved: 0,
  };

  it('VALID quand tout est cohérent', () => {
    expect(revalidateCartLine(base).status).toBe('VALID');
  });

  it('PRODUCT_UNAVAILABLE prioritaire sur tout le reste', () => {
    expect(
      revalidateCartLine({ ...base, productStatus: 'INACTIVE', currentPriceMinor: 9999 }).status,
    ).toBe('PRODUCT_UNAVAILABLE');
  });

  it('VARIANT_UNAVAILABLE pour une variante archivée', () => {
    expect(revalidateCartLine({ ...base, variantStatus: 'ARCHIVED' }).status).toBe(
      'VARIANT_UNAVAILABLE',
    );
  });

  it('PRICE_CHANGED jamais résolu silencieusement (statut explicite)', () => {
    const result = revalidateCartLine({ ...base, currentPriceMinor: 6000 });
    expect(result.status).toBe('PRICE_CHANGED');
    expect(result.currentPriceMinor).toBe(6000);
  });

  it('OUT_OF_STOCK et QUANTITY_REDUCED_REQUIRED avec maxQuantity', () => {
    expect(revalidateCartLine({ ...base, quantityOnHand: 0 }).status).toBe('OUT_OF_STOCK');
    const reduced = revalidateCartLine({ ...base, quantityOnHand: 1 });
    expect(reduced.status).toBe('QUANTITY_REDUCED_REQUIRED');
    expect(reduced.maxQuantity).toBe(1);
  });

  it('la réservation de CE panier ne compte pas comme stock pris', () => {
    // 2 en main, 2 réservés — mais réservés PAR CETTE LIGNE : toujours valide.
    const result = revalidateCartLine({
      ...base,
      quantityOnHand: 2,
      quantityReserved: 2,
      reservedByThisLine: 2,
    });
    expect(result.status).toBe('VALID');
  });

  it('backorder et non-suivi toujours VALID côté stock', () => {
    expect(
      revalidateCartLine({ ...base, quantityOnHand: 0, allowBackorder: true }).status,
    ).toBe('VALID');
    expect(
      revalidateCartLine({ ...base, quantityOnHand: 0, trackInventory: false }).status,
    ).toBe('VALID');
  });
});

describe('missingCheckoutFields (validé §13)', () => {
  const full = {
    fulfillmentType: 'DELIVERY' as const,
    customerName: 'Awa',
    customerPhone: '+237650000000',
    city: 'Douala',
    addressLine1: 'Rue 12',
    landmark: null,
    countryCode: 'CM',
  };

  it('PICKUP : nom + téléphone suffisent', () => {
    expect(
      missingCheckoutFields({ ...full, fulfillmentType: 'PICKUP', city: null, addressLine1: null, countryCode: null }),
    ).toEqual([]);
  });

  it('DELIVERY : ville + (adresse OU repère) + pays requis, postalCode jamais', () => {
    expect(missingCheckoutFields(full)).toEqual([]);
    expect(
      missingCheckoutFields({ ...full, addressLine1: null, landmark: 'Face pharmacie' }),
    ).toEqual([]);
    expect(missingCheckoutFields({ ...full, addressLine1: null })).toEqual(['addressLine1|landmark']);
    expect(missingCheckoutFields({ ...full, city: null, countryCode: null })).toEqual([
      'city',
      'countryCode',
    ]);
  });

  it('fulfillment non choisi = manquant', () => {
    expect(missingCheckoutFields({ ...full, fulfillmentType: null })).toContain('fulfillmentType');
  });
});

describe('buildCartSummaryText (format validé §24)', () => {
  it('produit le récapitulatif conversationnel attendu', () => {
    const text = buildCartSummaryText({
      lines: [
        { productName: 'Robe Élégance', variantName: 'Rouge / M', quantity: 1, lineSubtotalMinor: 25000 },
        { productName: 'Sac Classique', variantName: null, quantity: 1, lineSubtotalMinor: 10000 },
      ],
      currency: 'XAF',
      subtotalMinor: 35000,
      deliveryFeeMinor: 0,
      totalMinor: 35000,
      deliveryDecided: false,
    });
    expect(text).toContain('Votre panier :');
    expect(text).toContain('Robe Élégance — Rouge / M × 1');
    expect(text).toContain('Sac Classique × 1');
    expect(text).toContain('Livraison : à définir');
    expect(text.replace(/[\u00a0\u202f]/g, ' ')).toContain('Total actuel : 35 000');
  });
});

describe('transitions Cart (5 statuts — validé D2)', () => {
  it('table centrale respectée', () => {
    expect(isCartTransitionAllowed('ACTIVE', 'CHECKOUT_STARTED')).toBe(true);
    expect(isCartTransitionAllowed('CHECKOUT_STARTED', 'ACTIVE')).toBe(true);
    expect(isCartTransitionAllowed('CHECKOUT_STARTED', 'CONVERTED')).toBe(true);
    expect(isCartTransitionAllowed('ACTIVE', 'CONVERTED')).toBe(false);
    for (const terminal of ['CONVERTED', 'ABANDONED', 'EXPIRED'] as const) {
      expect(isCartTransitionAllowed(terminal, 'ACTIVE')).toBe(false);
    }
  });
});
