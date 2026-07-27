import { describe, expect, it } from 'vitest';

import { DomainError } from './errors';
import {
  EmailAlreadyUsedError,
  InvalidCredentialsError,
  RefreshTokenReuseDetectedError,
  WeakPasswordError,
} from './auth-errors';

describe('auth errors', () => {
  it('sets the expected code and HTTP status for each error', () => {
    expect(new InvalidCredentialsError()).toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    expect(new EmailAlreadyUsedError()).toMatchObject({ code: 'EMAIL_ALREADY_USED', httpStatus: 409 });
    expect(new RefreshTokenReuseDetectedError()).toMatchObject({
      code: 'REFRESH_TOKEN_REUSE_DETECTED',
      httpStatus: 401,
    });
  });

  it('includes the reason in the WeakPasswordError message', () => {
    const error = new WeakPasswordError('too short');
    expect(error.message).toContain('too short');
    expect(error).toBeInstanceOf(DomainError);
  });
});
