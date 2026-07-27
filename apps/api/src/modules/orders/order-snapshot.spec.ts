import { OrderSnapshotInvalidError } from '@whauto/shared';

import { parseConfirmationSnapshot } from './order-snapshot';

function validSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    cartId: 'cart-1',
    checkoutSessionId: 'checkout-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    shopId: 'shop-1',
    organizationId: 'org-1',
    currency: 'XAF',
    confirmedAt: new Date().toISOString(),
    cartVersion: 2,
    checkoutVersion: 2,
    lines: [
      {
        cartItemId: 'item-1',
        productId: 'product-1',
        variantId: 'variant-1',
        productName: 'Robe',
        variantName: 'M',
        sku: 'ROBE-M',
        imageUrl: 'https://example.test/img.png',
        optionValues: [['Taille', 'M']],
        unitPriceMinor: 5000,
        compareAtPriceMinor: null,
        quantity: 2,
        lineSubtotalMinor: 10000,
        productType: 'PHYSICAL',
        trackInventory: true,
        allowBackorder: false,
      },
    ],
    subtotalMinor: 10000,
    discountMinor: 0,
    deliveryFeeMinor: 0,
    totalMinor: 10000,
    fulfillmentType: 'PICKUP',
    customer: { name: 'Awa', phone: '+237650000000', email: null },
    address: {
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      countryCode: null,
      landmark: null,
    },
    deliveryInstructions: null,
    paymentPreference: 'CASH_ON_DELIVERY',
    reservations: [{ id: 'res-1', cartItemId: 'item-1', quantity: 2, expiresAt: new Date().toISOString() }],
    ...overrides,
  };
}

describe('parseConfirmationSnapshot — parse défensif, snapshot = autorité exclusive', () => {
  it('accepte un snapshot valide enrichi (validé — ajustement 3)', () => {
    const parsed = parseConfirmationSnapshot(validSnapshot());
    expect(parsed.lines[0].productType).toBe('PHYSICAL');
    expect(parsed.lines[0].trackInventory).toBe(true);
    expect(parsed.checkoutSessionId).toBe('checkout-1');
  });

  it('rejette null/undefined/tableau', () => {
    expect(() => parseConfirmationSnapshot(null)).toThrow(OrderSnapshotInvalidError);
    expect(() => parseConfirmationSnapshot(undefined)).toThrow(OrderSnapshotInvalidError);
    expect(() => parseConfirmationSnapshot([])).toThrow(OrderSnapshotInvalidError);
  });

  it('rejette un snapshot ANTÉRIEUR sans productType/trackInventory (aucun fallback, ajustement 4)', () => {
    const legacy = validSnapshot();
    // @ts-expect-error simulate legacy snapshot missing enriched fields
    delete legacy.lines[0].productType;
    expect(() => parseConfirmationSnapshot(legacy)).toThrow(OrderSnapshotInvalidError);
  });

  it('rejette des totaux incohérents', () => {
    expect(() =>
      parseConfirmationSnapshot(validSnapshot({ totalMinor: 99999 })),
    ).toThrow(OrderSnapshotInvalidError);
  });

  it('rejette un sous-total qui ne correspond pas à la somme des lignes', () => {
    expect(() =>
      parseConfirmationSnapshot(validSnapshot({ subtotalMinor: 5000, totalMinor: 5000 })),
    ).toThrow(OrderSnapshotInvalidError);
  });

  it('rejette une ligne dont lineSubtotalMinor ne correspond pas à prix × quantité', () => {
    const bad = validSnapshot();
    (bad.lines[0] as { lineSubtotalMinor: number }).lineSubtotalMinor = 1;
    expect(() => parseConfirmationSnapshot(bad)).toThrow(OrderSnapshotInvalidError);
  });

  it('rejette un fulfillmentType ou paymentPreference invalide', () => {
    expect(() =>
      parseConfirmationSnapshot(validSnapshot({ fulfillmentType: 'TELEPORT' })),
    ).toThrow(OrderSnapshotInvalidError);
    expect(() =>
      parseConfirmationSnapshot(validSnapshot({ paymentPreference: 'BITCOIN' })),
    ).toThrow(OrderSnapshotInvalidError);
  });

  it('accepte des lignes sans réservations (variante non suivie)', () => {
    const parsed = parseConfirmationSnapshot(
      validSnapshot({
        lines: [
          {
            cartItemId: 'item-2',
            productId: 'product-2',
            variantId: 'variant-2',
            productName: 'Service',
            variantName: null,
            sku: 'SVC-1',
            imageUrl: null,
            optionValues: null,
            unitPriceMinor: 10000,
            compareAtPriceMinor: null,
            quantity: 1,
            lineSubtotalMinor: 10000,
            productType: 'SERVICE',
            trackInventory: false,
            allowBackorder: false,
          },
        ],
        reservations: [],
      }),
    );
    expect(parsed.lines[0].trackInventory).toBe(false);
    expect(parsed.reservations).toHaveLength(0);
  });
});
