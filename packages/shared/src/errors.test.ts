import { describe, expect, it } from 'vitest';

import { ConflictError, DomainError, NotFoundError } from './errors';

describe('DomainError hierarchy', () => {
  it('sets a default code on DomainError', () => {
    const error = new DomainError('something went wrong');
    expect(error.code).toBe('DOMAIN_ERROR');
    expect(error).toBeInstanceOf(Error);
  });

  it('sets NOT_FOUND code and preserves instanceof DomainError', () => {
    const error = new NotFoundError('organization not found');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.name).toBe('NotFoundError');
    expect(error).toBeInstanceOf(DomainError);
  });

  it('sets CONFLICT code', () => {
    const error = new ConflictError('slug already taken');
    expect(error.code).toBe('CONFLICT');
    expect(error).toBeInstanceOf(DomainError);
  });
});
