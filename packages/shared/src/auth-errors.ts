import { DomainError } from './errors';

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('Invalid email or password.', 'INVALID_CREDENTIALS', 401);
    this.name = 'InvalidCredentialsError';
  }
}

export class EmailAlreadyUsedError extends DomainError {
  constructor() {
    super('An account with this email already exists.', 'EMAIL_ALREADY_USED', 409);
    this.name = 'EmailAlreadyUsedError';
  }
}

export class UserNotActiveError extends DomainError {
  constructor() {
    super('This account is not active.', 'USER_NOT_ACTIVE', 403);
    this.name = 'UserNotActiveError';
  }
}

/** Non appliquée dans cette phase — réservée à un futur EmailVerifiedGuard (voir CLAUDE.md). */
export class EmailNotVerifiedError extends DomainError {
  constructor() {
    super('This action requires a verified email address.', 'EMAIL_NOT_VERIFIED', 403);
    this.name = 'EmailNotVerifiedError';
  }
}

export class InvalidRefreshTokenError extends DomainError {
  constructor() {
    super('Invalid or expired refresh token.', 'INVALID_REFRESH_TOKEN', 401);
    this.name = 'InvalidRefreshTokenError';
  }
}

export class RefreshTokenReuseDetectedError extends DomainError {
  constructor() {
    super('Refresh token reuse detected. All sessions in this family were revoked.', 'REFRESH_TOKEN_REUSE_DETECTED', 401);
    this.name = 'RefreshTokenReuseDetectedError';
  }
}

export class InvalidVerificationTokenError extends DomainError {
  constructor() {
    super('Invalid or expired email verification token.', 'INVALID_VERIFICATION_TOKEN', 400);
    this.name = 'InvalidVerificationTokenError';
  }
}

export class InvalidPasswordResetTokenError extends DomainError {
  constructor() {
    super('Invalid or expired password reset token.', 'INVALID_PASSWORD_RESET_TOKEN', 400);
    this.name = 'InvalidPasswordResetTokenError';
  }
}

export class WeakPasswordError extends DomainError {
  constructor(reason: string) {
    super(`Password does not meet the strength requirements: ${reason}`, 'WEAK_PASSWORD', 400);
    this.name = 'WeakPasswordError';
  }
}

export class SessionRevokedError extends DomainError {
  constructor() {
    super('This session has been revoked.', 'SESSION_REVOKED', 401);
    this.name = 'SessionRevokedError';
  }
}

/**
 * Ajoutée au-delà de la liste initiale : nécessaire pour empêcher la
 * réutilisation immédiate du même mot de passe lors d'un changement (section 14).
 */
export class PasswordReuseError extends DomainError {
  constructor() {
    super('The new password must be different from the current one.', 'PASSWORD_REUSE', 400);
    this.name = 'PasswordReuseError';
  }
}
