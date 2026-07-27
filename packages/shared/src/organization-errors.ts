import { DomainError } from './errors';

/**
 * 404 volontaire (et non 403) pour un non-membre : ne révèle jamais
 * l'existence d'une organisation à laquelle on n'appartient pas.
 */
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('Organization not found.', 'ORGANIZATION_NOT_FOUND', 404);
    this.name = 'OrganizationNotFoundError';
  }
}

export class OrganizationSlugAlreadyUsedError extends DomainError {
  constructor() {
    super('This organization slug is already in use.', 'ORGANIZATION_SLUG_ALREADY_USED', 409);
    this.name = 'OrganizationSlugAlreadyUsedError';
  }
}

export class OrganizationArchivedError extends DomainError {
  constructor() {
    super('This organization is archived.', 'ORGANIZATION_ARCHIVED', 403);
    this.name = 'OrganizationArchivedError';
  }
}

export class OrganizationSuspendedError extends DomainError {
  constructor() {
    super('This organization is suspended.', 'ORGANIZATION_SUSPENDED', 403);
    this.name = 'OrganizationSuspendedError';
  }
}

export class MembershipNotFoundError extends DomainError {
  constructor() {
    super('Membership not found.', 'MEMBERSHIP_NOT_FOUND', 404);
    this.name = 'MembershipNotFoundError';
  }
}

export class MembershipInactiveError extends DomainError {
  constructor() {
    super('This membership is not active.', 'MEMBERSHIP_INACTIVE', 403);
    this.name = 'MembershipInactiveError';
  }
}

export class InsufficientPermissionError extends DomainError {
  constructor() {
    super('You do not have permission to perform this action.', 'INSUFFICIENT_PERMISSION', 403);
    this.name = 'InsufficientPermissionError';
  }
}

export class CannotRemoveOwnerError extends DomainError {
  constructor() {
    super('The organization owner cannot be removed.', 'CANNOT_REMOVE_OWNER', 403);
    this.name = 'CannotRemoveOwnerError';
  }
}

export class CannotLeaveAsOwnerError extends DomainError {
  constructor() {
    super(
      'The owner cannot leave the organization. Ownership transfer is not available yet.',
      'CANNOT_LEAVE_AS_OWNER',
      403,
    );
    this.name = 'CannotLeaveAsOwnerError';
  }
}

/**
 * Réponse volontairement identique pour : token inconnu, invitation d'une autre
 * organisation, invitation annulée/refusée — pas d'énumération de tokens.
 */
export class InvitationNotFoundError extends DomainError {
  constructor() {
    super('Invitation not found.', 'INVITATION_NOT_FOUND', 404);
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationExpiredError extends DomainError {
  constructor() {
    super('This invitation has expired.', 'INVITATION_EXPIRED', 400);
    this.name = 'InvitationExpiredError';
  }
}

export class InvitationAlreadyUsedError extends DomainError {
  constructor() {
    super('This invitation has already been used.', 'INVITATION_ALREADY_USED', 400);
    this.name = 'InvitationAlreadyUsedError';
  }
}

export class InvitationEmailMismatchError extends DomainError {
  constructor() {
    super(
      'This invitation was issued for a different email address.',
      'INVITATION_EMAIL_MISMATCH',
      403,
    );
    this.name = 'InvitationEmailMismatchError';
  }
}

export class InvitationAlreadyExistsError extends DomainError {
  constructor() {
    super(
      'An active invitation already exists for this email in this organization.',
      'INVITATION_ALREADY_EXISTS',
      409,
    );
    this.name = 'InvitationAlreadyExistsError';
  }
}

export class UserAlreadyMemberError extends DomainError {
  constructor() {
    super('This user is already a member of the organization.', 'USER_ALREADY_MEMBER', 409);
    this.name = 'UserAlreadyMemberError';
  }
}

export class InvalidRoleTransitionError extends DomainError {
  constructor(reason: string) {
    super(`Invalid role change: ${reason}`, 'INVALID_ROLE_TRANSITION', 403);
    this.name = 'InvalidRoleTransitionError';
  }
}

/** Path param et header X-Organization-Id présents mais différents : ambiguïté rejetée. */
export class AmbiguousOrganizationSelectorError extends DomainError {
  constructor() {
    super(
      'Conflicting organization identifiers between URL and X-Organization-Id header.',
      'AMBIGUOUS_ORGANIZATION_SELECTOR',
      400,
    );
    this.name = 'AmbiguousOrganizationSelectorError';
  }
}
