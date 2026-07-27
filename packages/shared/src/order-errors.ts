import { DomainError } from './errors';

/** 404 : commande inexistante OU d'une autre organisation (anti-énumération). */
export class OrderNotFoundError extends DomainError {
  constructor() {
    super('Order not found.', 'ORDER_NOT_FOUND', 404);
    this.name = 'OrderNotFoundError';
  }
}

export class OrderAlreadyExistsError extends DomainError {
  constructor() {
    super('An order already exists for this checkout session.', 'ORDER_ALREADY_EXISTS', 409);
    this.name = 'OrderAlreadyExistsError';
  }
}

export class OrderConversionNotAllowedError extends DomainError {
  constructor(reason: string) {
    super(`Order conversion is not allowed: ${reason}.`, 'ORDER_CONVERSION_NOT_ALLOWED', 409);
    this.name = 'OrderConversionNotAllowedError';
  }
}

export class OrderCheckoutNotConfirmedError extends DomainError {
  constructor() {
    super(
      'The checkout session is not confirmed — confirm the checkout first.',
      'ORDER_CHECKOUT_NOT_CONFIRMED',
      422,
    );
    this.name = 'OrderCheckoutNotConfirmedError';
  }
}

/** Le confirmationSnapshot stocké est absent ou structurellement invalide. */
export class OrderSnapshotInvalidError extends DomainError {
  constructor(detail: string) {
    super(`The confirmation snapshot is invalid: ${detail}.`, 'ORDER_SNAPSHOT_INVALID', 422);
    this.name = 'OrderSnapshotInvalidError';
  }
}

export class OrderReservationMissingError extends DomainError {
  constructor() {
    super(
      'A required stock reservation is missing — restart the checkout to reserve stock again.',
      'ORDER_RESERVATION_MISSING',
      409,
    );
    this.name = 'OrderReservationMissingError';
  }
}

export class OrderReservationExpiredError extends DomainError {
  constructor() {
    super(
      'A stock reservation expired — restart the checkout to reserve stock again.',
      'ORDER_RESERVATION_EXPIRED',
      409,
    );
    this.name = 'OrderReservationExpiredError';
  }
}

/** La réservation ACTIVE ne correspond pas à la quantité de la ligne. */
export class OrderReservationMismatchError extends DomainError {
  constructor() {
    super(
      'A stock reservation does not match the ordered quantity.',
      'ORDER_RESERVATION_MISMATCH',
      409,
    );
    this.name = 'OrderReservationMismatchError';
  }
}

export class OrderStockConsumptionError extends DomainError {
  constructor() {
    super(
      'Stock consumption failed — inventory state changed during conversion.',
      'ORDER_STOCK_CONSUMPTION_FAILED',
      409,
    );
    this.name = 'OrderStockConsumptionError';
  }
}

export class OrderInvalidStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Invalid order status transition: ${from} → ${to}.`,
      'ORDER_INVALID_STATUS_TRANSITION',
      422,
    );
    this.name = 'OrderInvalidStatusTransitionError';
  }
}

export class OrderCancellationNotAllowedError extends DomainError {
  constructor(status: string) {
    super(
      `The order can no longer be cancelled (current status: ${status}).`,
      'ORDER_CANCELLATION_NOT_ALLOWED',
      422,
    );
    this.name = 'OrderCancellationNotAllowedError';
  }
}

export class OrderAlreadyCancelledError extends DomainError {
  constructor() {
    super('The order is already cancelled.', 'ORDER_ALREADY_CANCELLED', 409);
    this.name = 'OrderAlreadyCancelledError';
  }
}

/** Version périmée : l'UI recharge la commande et l'utilisateur reconfirme. */
export class OrderConcurrencyError extends DomainError {
  constructor() {
    super(
      'The order was modified by another operation. Reload and try again.',
      'ORDER_CONCURRENCY',
      409,
    );
    this.name = 'OrderConcurrencyError';
  }
}

export class OrderNumberGenerationError extends DomainError {
  constructor() {
    super('Order number generation failed. Try again.', 'ORDER_NUMBER_GENERATION_FAILED', 500);
    this.name = 'OrderNumberGenerationError';
  }
}

/**
 * Restitution impossible (InventoryItem requis absent) : l'annulation est
 * intégralement annulée — jamais de restitution silencieuse à zéro (validé —
 * ajustement 9).
 */
export class OrderStockRestorationError extends DomainError {
  constructor() {
    super(
      'Stock restoration failed — a required inventory record is missing. The cancellation was rolled back.',
      'ORDER_STOCK_RESTORATION_FAILED',
      409,
    );
    this.name = 'OrderStockRestorationError';
  }
}
