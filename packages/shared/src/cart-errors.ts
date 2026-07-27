import { DomainError } from './errors';

/** 404 : panier inexistant OU d'une autre organisation/Shop (anti-énumération). */
export class CartNotFoundError extends DomainError {
  constructor() {
    super('Cart not found.', 'CART_NOT_FOUND', 404);
    this.name = 'CartNotFoundError';
  }
}

export class CartNotActiveError extends DomainError {
  constructor(status: string) {
    super(`The cart is not in the required state (current: ${status}).`, 'CART_NOT_ACTIVE', 409);
    this.name = 'CartNotActiveError';
  }
}

export class CartAlreadyExistsError extends DomainError {
  constructor() {
    super('An open cart already exists for this conversation.', 'CART_ALREADY_EXISTS', 409);
    this.name = 'CartAlreadyExistsError';
  }
}

export class CartItemNotFoundError extends DomainError {
  constructor() {
    super('Cart item not found.', 'CART_ITEM_NOT_FOUND', 404);
    this.name = 'CartItemNotFoundError';
  }
}

export class CartEmptyError extends DomainError {
  constructor() {
    super('The cart is empty.', 'CART_EMPTY', 422);
    this.name = 'CartEmptyError';
  }
}

export class CartCurrencyMismatchError extends DomainError {
  constructor() {
    super(
      'The product currency does not match the cart currency.',
      'CART_CURRENCY_MISMATCH',
      409,
    );
    this.name = 'CartCurrencyMismatchError';
  }
}

/** Des lignes non-VALID bloquent le checkout : revalider et résoudre d'abord. */
export class CartRevalidationRequiredError extends DomainError {
  constructor(public readonly lines: Array<{ cartItemId: string; status: string }>) {
    super(
      'Some cart lines require attention before checkout (price/stock/availability changed).',
      'CART_REVALIDATION_REQUIRED',
      422,
    );
    this.name = 'CartRevalidationRequiredError';
  }
}

export class CartPriceChangedError extends DomainError {
  constructor() {
    super(
      'The catalog price changed — accept the current price explicitly or remove the line.',
      'CART_PRICE_CHANGED',
      409,
    );
    this.name = 'CartPriceChangedError';
  }
}

export class CartProductUnavailableError extends DomainError {
  constructor() {
    super('The product or variant is no longer available.', 'CART_PRODUCT_UNAVAILABLE', 409);
    this.name = 'CartProductUnavailableError';
  }
}

export class CartInsufficientStockError extends DomainError {
  constructor() {
    super('Insufficient available stock for the requested quantity.', 'CART_INSUFFICIENT_STOCK', 409);
    this.name = 'CartInsufficientStockError';
  }
}

export class CheckoutNotFoundError extends DomainError {
  constructor() {
    super('Checkout session not found.', 'CHECKOUT_NOT_FOUND', 404);
    this.name = 'CheckoutNotFoundError';
  }
}

export class CheckoutIncompleteError extends DomainError {
  constructor(public readonly missingFields: string[]) {
    super(
      `The checkout is incomplete: ${missingFields.join(', ')}.`,
      'CHECKOUT_INCOMPLETE',
      422,
    );
    this.name = 'CheckoutIncompleteError';
  }
}

export class CheckoutAlreadyConfirmedError extends DomainError {
  constructor() {
    super(
      'The checkout is already confirmed — the cart is no longer modifiable.',
      'CHECKOUT_ALREADY_CONFIRMED',
      409,
    );
    this.name = 'CheckoutAlreadyConfirmedError';
  }
}

export class StockReservationFailedError extends DomainError {
  constructor(public readonly failedLines: Array<{ cartItemId: string; sku: string }>) {
    super(
      'Stock reservation failed for one or more lines — nothing was reserved.',
      'STOCK_RESERVATION_FAILED',
      409,
    );
    this.name = 'StockReservationFailedError';
  }
}

export class StockReservationExpiredError extends DomainError {
  constructor() {
    super(
      'The stock reservation expired — restart the reservation before confirming.',
      'STOCK_RESERVATION_EXPIRED',
      409,
    );
    this.name = 'StockReservationExpiredError';
  }
}

export class ReservationConcurrencyError extends DomainError {
  constructor() {
    super(
      'The reservation was modified concurrently. Reload and retry.',
      'RESERVATION_CONCURRENCY',
      409,
    );
    this.name = 'ReservationConcurrencyError';
  }
}

/** Verrou optimiste : expectedVersion périmée — recharger puis réessayer. */
export class CartConcurrencyError extends DomainError {
  constructor() {
    super(
      'The cart or checkout was modified concurrently. Reload and retry.',
      'CART_CONCURRENCY',
      409,
    );
    this.name = 'CartConcurrencyError';
  }
}
