import { describe, expect, it } from 'vitest';

import {
  buildOrderSummaryText,
  canDeliverWithPayment,
  derivedFulfillmentStatus,
  deriveOrderNumberPrefixCandidate,
  formatOrderNumber,
  initialFulfillmentStatus,
  initialPaymentStatus,
  isOrderTransitionAllowed,
  isPaymentToCollect,
  ORDER_CANCELLABLE_STATUSES,
} from './order';

describe('transitions OrderStatus (table centrale — validé §11)', () => {
  it('chaîne nominale DELIVERY : CONFIRMED → PROCESSING → READY → SHIPPED → DELIVERED', () => {
    expect(isOrderTransitionAllowed('CONFIRMED', 'PROCESSING', 'DELIVERY')).toBe(true);
    expect(isOrderTransitionAllowed('PROCESSING', 'READY', 'DELIVERY')).toBe(true);
    expect(isOrderTransitionAllowed('READY', 'SHIPPED', 'DELIVERY')).toBe(true);
    expect(isOrderTransitionAllowed('SHIPPED', 'DELIVERED', 'DELIVERY')).toBe(true);
  });

  it('READY → DELIVERED réservé au PICKUP ; READY → SHIPPED réservé à DELIVERY', () => {
    expect(isOrderTransitionAllowed('READY', 'DELIVERED', 'PICKUP')).toBe(true);
    expect(isOrderTransitionAllowed('READY', 'DELIVERED', 'DELIVERY')).toBe(false);
    expect(isOrderTransitionAllowed('READY', 'SHIPPED', 'PICKUP')).toBe(false);
  });

  it('SHIPPED → CANCELLED refusé (workflow retour hors scope) ; terminaux figés', () => {
    expect(isOrderTransitionAllowed('SHIPPED', 'CANCELLED', 'DELIVERY')).toBe(false);
    expect(isOrderTransitionAllowed('DELIVERED', 'CANCELLED', 'DELIVERY')).toBe(false);
    expect(isOrderTransitionAllowed('CANCELLED', 'CONFIRMED', 'DELIVERY')).toBe(false);
  });

  it('aucun saut : CONFIRMED → READY/SHIPPED/DELIVERED interdits', () => {
    expect(isOrderTransitionAllowed('CONFIRMED', 'READY', 'DELIVERY')).toBe(false);
    expect(isOrderTransitionAllowed('CONFIRMED', 'SHIPPED', 'DELIVERY')).toBe(false);
    expect(isOrderTransitionAllowed('CONFIRMED', 'DELIVERED', 'PICKUP')).toBe(false);
  });

  it('annulables : CONFIRMED, PROCESSING, READY uniquement (validé D9)', () => {
    expect(ORDER_CANCELLABLE_STATUSES).toEqual(['CONFIRMED', 'PROCESSING', 'READY']);
  });
});

describe('mapping paymentPreference → paymentStatus initial (validé — ajustement 12)', () => {
  it('UNPAID pour les encaissements hors ligne, PENDING pour les électroniques', () => {
    expect(initialPaymentStatus('CASH_ON_DELIVERY')).toBe('UNPAID');
    expect(initialPaymentStatus('PAY_IN_STORE')).toBe('UNPAID');
    expect(initialPaymentStatus('UNDECIDED')).toBe('UNPAID');
    expect(initialPaymentStatus('MOBILE_MONEY')).toBe('PENDING');
    expect(initialPaymentStatus('CARD')).toBe('PENDING');
  });
});

describe('fulfillment initial depuis les productType du SNAPSHOT (validé D5 + ajust. 6)', () => {
  it('NOT_REQUIRED seulement si TOUTES les lignes sont SERVICE/DIGITAL', () => {
    expect(initialFulfillmentStatus(['SERVICE', 'DIGITAL'])).toBe('NOT_REQUIRED');
    expect(initialFulfillmentStatus(['SERVICE', 'PHYSICAL'])).toBe('PENDING');
    expect(initialFulfillmentStatus(['PHYSICAL'])).toBe('PENDING');
    expect(initialFulfillmentStatus([])).toBe('PENDING');
  });
});

describe('fulfillment dérivé des transitions (service centralisé — validé §14)', () => {
  it('suit le statut de commande selon le type', () => {
    expect(derivedFulfillmentStatus('PROCESSING', 'DELIVERY', 'PENDING')).toBe('PREPARING');
    expect(derivedFulfillmentStatus('READY', 'PICKUP', 'PREPARING')).toBe('READY_FOR_PICKUP');
    expect(derivedFulfillmentStatus('READY', 'DELIVERY', 'PREPARING')).toBe('READY_FOR_SHIPMENT');
    expect(derivedFulfillmentStatus('SHIPPED', 'DELIVERY', 'READY_FOR_SHIPMENT')).toBe('IN_TRANSIT');
    expect(derivedFulfillmentStatus('DELIVERED', 'PICKUP', 'READY_FOR_PICKUP')).toBe('DELIVERED');
    expect(derivedFulfillmentStatus('CANCELLED', 'DELIVERY', 'PREPARING')).toBe('CANCELLED');
  });

  it('NOT_REQUIRED jamais modifié (même à l’annulation)', () => {
    expect(derivedFulfillmentStatus('PROCESSING', 'PICKUP', 'NOT_REQUIRED')).toBe('NOT_REQUIRED');
    expect(derivedFulfillmentStatus('CANCELLED', 'PICKUP', 'NOT_REQUIRED')).toBe('NOT_REQUIRED');
  });
});

describe('cohérence paiement/livraison (validé — ajustement 18)', () => {
  it('DELIVERED accepté : PAID toujours ; UNPAID seulement à encaissement hors ligne', () => {
    expect(canDeliverWithPayment('PAID', 'CARD')).toBe(true);
    expect(canDeliverWithPayment('UNPAID', 'CASH_ON_DELIVERY')).toBe(true);
    expect(canDeliverWithPayment('UNPAID', 'PAY_IN_STORE')).toBe(true);
    expect(canDeliverWithPayment('UNPAID', 'CARD')).toBe(false);
    expect(canDeliverWithPayment('PENDING', 'MOBILE_MONEY')).toBe(false);
  });

  it('« paiement à encaisser » signalé, jamais converti automatiquement en PAID', () => {
    expect(isPaymentToCollect('UNPAID', 'CASH_ON_DELIVERY')).toBe(true);
    expect(isPaymentToCollect('PAID', 'CASH_ON_DELIVERY')).toBe(false);
    expect(isPaymentToCollect('UNPAID', 'CARD')).toBe(false);
  });
});

describe('numéro de commande (validé — ajustement 1)', () => {
  it('candidat de préfixe : alphanumérique majuscule, max 8, fallback WHA', () => {
    expect(deriveOrderNumberPrefixCandidate('fashion-douala')).toBe('FASHIOND');
    expect(deriveOrderNumberPrefixCandidate('ma-boutique')).toBe('MABOUTIQ');
    expect(deriveOrderNumberPrefixCandidate('---')).toBe('WHA');
  });

  it('deux slugs différents peuvent produire le MÊME candidat tronqué — l’unicité est tranchée ailleurs', () => {
    // C'est exactement le cas que l'index CI + suffixe numérique résout.
    expect(deriveOrderNumberPrefixCandidate('fashionland')).toBe(
      deriveOrderNumberPrefixCandidate('fashionland-bis'),
    );
  });

  it('format PREFIX-YYYY-NNNNNN, compteur sur 6 chiffres', () => {
    expect(formatOrderNumber('FASHION', 2026, 123)).toBe('FASHION-2026-000123');
    expect(formatOrderNumber('WHA', 2026, 1)).toBe('WHA-2026-000001');
    expect(formatOrderNumber('WHA', 2026, 1234567)).toBe('WHA-2026-1234567');
  });
});

describe('buildOrderSummaryText (format validé §29)', () => {
  it('récapitulatif conversationnel complet', () => {
    const text = buildOrderSummaryText({
      orderNumber: 'WHA-2026-000123',
      status: 'CONFIRMED',
      lines: [
        { productName: 'Robe Élégance', variantName: 'Rouge / M', quantity: 1, lineSubtotalMinor: 25000 },
        { productName: 'Sac Classique', variantName: null, quantity: 1, lineSubtotalMinor: 10000 },
      ],
      currency: 'XAF',
      totalMinor: 35000,
      deliveryFeeMinor: 0,
      fulfillmentType: 'DELIVERY',
      city: 'Douala',
      landmark: 'Bonamoussadi',
      paymentPreference: 'CASH_ON_DELIVERY',
    });
    expect(text).toContain('Commande WHA-2026-000123 confirmée');
    expect(text).toContain('Robe Élégance — Rouge / M × 1');
    expect(text).toContain('Sac Classique × 1');
    expect(text.replace(/[\u00a0\u202f]/g, ' ')).toContain('Total : 35 000');
    expect(text).toContain('Livraison : Douala, Bonamoussadi');
    expect(text).toContain('Paiement : À la livraison');
  });

  it('PICKUP : mention du retrait, pas d’adresse', () => {
    const text = buildOrderSummaryText({
      orderNumber: 'WHA-2026-000002',
      status: 'READY',
      lines: [{ productName: 'Casquette', variantName: null, quantity: 2, lineSubtotalMinor: 15000 }],
      currency: 'XAF',
      totalMinor: 15000,
      deliveryFeeMinor: 0,
      fulfillmentType: 'PICKUP',
      city: null,
      landmark: null,
      paymentPreference: 'PAY_IN_STORE',
    });
    expect(text).toContain('Retrait en boutique');
    expect(text).not.toContain('Livraison :');
  });
});
