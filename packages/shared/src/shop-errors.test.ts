import { describe, expect, it } from 'vitest';

import { DomainError } from './errors';
import {
  InvalidOpeningHoursError,
  InvalidShopStatusTransitionError,
  OverlappingOpeningHoursError,
  ShopActivationRequirementsError,
  ShopArchivedError,
  ShopNotFoundError,
  ShopSlugAlreadyUsedError,
} from './shop-errors';

describe('shop errors', () => {
  const cases: Array<[DomainError, string, number]> = [
    [new ShopNotFoundError(), 'SHOP_NOT_FOUND', 404],
    [new ShopSlugAlreadyUsedError(), 'SHOP_SLUG_ALREADY_USED', 409],
    [new ShopArchivedError(), 'SHOP_ARCHIVED', 403],
    [new InvalidShopStatusTransitionError('ACTIVE', 'DRAFT'), 'INVALID_SHOP_STATUS_TRANSITION', 409],
    [new ShopActivationRequirementsError(['name']), 'SHOP_ACTIVATION_REQUIREMENTS', 422],
    [new InvalidOpeningHoursError('test'), 'INVALID_OPENING_HOURS', 400],
    [new OverlappingOpeningHoursError('MONDAY'), 'OVERLAPPING_OPENING_HOURS', 400],
  ];

  it.each(cases.map(([error, code, status]) => [code, error, status]))(
    '%s expose le bon code et statut HTTP',
    (code, error, status) => {
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
    },
  );

  it('les messages contextuels intègrent les détails', () => {
    expect(new InvalidShopStatusTransitionError('ARCHIVED', 'ACTIVE').message).toContain(
      'ARCHIVED -> ACTIVE',
    );
    expect(new ShopActivationRequirementsError(['countryCode', 'currency']).message).toContain(
      'countryCode, currency',
    );
    expect(new OverlappingOpeningHoursError('MONDAY').message).toContain('MONDAY');
  });
});
