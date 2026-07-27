import { DomainError } from './errors';

/** 404 pour une Shop inexistante OU appartenant à une autre organisation (anti-énumération). */
export class ShopNotFoundError extends DomainError {
  constructor() {
    super('Shop not found.', 'SHOP_NOT_FOUND', 404);
    this.name = 'ShopNotFoundError';
  }
}

export class ShopSlugAlreadyUsedError extends DomainError {
  constructor() {
    super(
      'This shop slug is already in use within the organization.',
      'SHOP_SLUG_ALREADY_USED',
      409,
    );
    this.name = 'ShopSlugAlreadyUsedError';
  }
}

export class ShopArchivedError extends DomainError {
  constructor() {
    super('This shop is archived and can no longer be modified.', 'SHOP_ARCHIVED', 403);
    this.name = 'ShopArchivedError';
  }
}

/** Couvre toutes les transitions invalides, y compris "déjà dans cet état". */
export class InvalidShopStatusTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Invalid shop status transition: ${from} -> ${to}.`,
      'INVALID_SHOP_STATUS_TRANSITION',
      409,
    );
    this.name = 'InvalidShopStatusTransitionError';
  }
}

export class ShopActivationRequirementsError extends DomainError {
  constructor(missingFields: string[]) {
    super(
      `The shop cannot be activated. Missing required fields: ${missingFields.join(', ')}.`,
      'SHOP_ACTIVATION_REQUIREMENTS',
      422,
    );
    this.name = 'ShopActivationRequirementsError';
  }
}

export class InvalidOpeningHoursError extends DomainError {
  constructor(reason: string) {
    super(`Invalid opening hours: ${reason}`, 'INVALID_OPENING_HOURS', 400);
    this.name = 'InvalidOpeningHoursError';
  }
}

export class OverlappingOpeningHoursError extends DomainError {
  constructor(dayOfWeek: string) {
    super(
      `Opening hour periods overlap on ${dayOfWeek}.`,
      'OVERLAPPING_OPENING_HOURS',
      400,
    );
    this.name = 'OverlappingOpeningHoursError';
  }
}
