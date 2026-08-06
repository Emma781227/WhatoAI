/**
 * Conversion d'unités et contrôle montant/devise (purs). Le Wallet raisonne en
 * unité MINEURE (base Whauto) ; Genius Pay renvoie l'unité MAJEURE. Ce module
 * recoupe le montant annoncé par l'agrégateur avec le TopUp FIGÉ — aucune
 * logique de crédits ici (juste une comparaison déterministe).
 */

/** Nombre de décimales de la devise (ICU) — XOF/XAF = 0, USD = 2, etc. */
export function minorUnitDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Convertit une unité MINEURE vers l'unité MAJEURE attendue par l'agrégateur. */
export function toMajorUnits(minor: number, currency: string): number {
  const digits = minorUnitDigits(currency);
  return digits === 0 ? minor : minor / 10 ** digits;
}

export type PaymentAmountMismatch = 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH';

export interface PaymentAmountCheck {
  ok: boolean;
  reason: PaymentAmountMismatch | null;
}

/**
 * Vérifie que le montant/devise annoncés par l'agrégateur correspondent au TopUp
 * FIGÉ. Devise comparée insensible à la casse ; montant comparé en unité MAJEURE.
 * Un montant/devise absent est traité comme une INCOHÉRENCE (jamais un crédit).
 */
export function checkPaymentAmount(input: {
  topUpAmountMinor: number;
  topUpCurrency: string;
  providerAmount: number | null;
  providerCurrency: string | null;
}): PaymentAmountCheck {
  if (
    !input.providerCurrency ||
    input.providerCurrency.toUpperCase() !== input.topUpCurrency.toUpperCase()
  ) {
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  const expectedMajor = toMajorUnits(input.topUpAmountMinor, input.topUpCurrency);
  if (input.providerAmount === null || input.providerAmount !== expectedMajor) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  return { ok: true, reason: null };
}
