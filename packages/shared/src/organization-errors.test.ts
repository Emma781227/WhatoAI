import { describe, expect, it } from 'vitest';

import { DomainError } from './errors';
import {
  AmbiguousOrganizationSelectorError,
  CannotLeaveAsOwnerError,
  CannotRemoveOwnerError,
  InsufficientPermissionError,
  InvalidRoleTransitionError,
  InvitationAlreadyExistsError,
  InvitationAlreadyUsedError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  MembershipInactiveError,
  MembershipNotFoundError,
  OrganizationArchivedError,
  OrganizationNotFoundError,
  OrganizationSlugAlreadyUsedError,
  OrganizationSuspendedError,
  UserAlreadyMemberError,
} from './organization-errors';

describe('organization errors', () => {
  const cases: Array<[DomainError, string, number]> = [
    [new OrganizationNotFoundError(), 'ORGANIZATION_NOT_FOUND', 404],
    [new OrganizationSlugAlreadyUsedError(), 'ORGANIZATION_SLUG_ALREADY_USED', 409],
    [new OrganizationArchivedError(), 'ORGANIZATION_ARCHIVED', 403],
    [new OrganizationSuspendedError(), 'ORGANIZATION_SUSPENDED', 403],
    [new MembershipNotFoundError(), 'MEMBERSHIP_NOT_FOUND', 404],
    [new MembershipInactiveError(), 'MEMBERSHIP_INACTIVE', 403],
    [new InsufficientPermissionError(), 'INSUFFICIENT_PERMISSION', 403],
    [new CannotRemoveOwnerError(), 'CANNOT_REMOVE_OWNER', 403],
    [new CannotLeaveAsOwnerError(), 'CANNOT_LEAVE_AS_OWNER', 403],
    [new InvitationNotFoundError(), 'INVITATION_NOT_FOUND', 404],
    [new InvitationExpiredError(), 'INVITATION_EXPIRED', 400],
    [new InvitationAlreadyUsedError(), 'INVITATION_ALREADY_USED', 400],
    [new InvitationEmailMismatchError(), 'INVITATION_EMAIL_MISMATCH', 403],
    [new InvitationAlreadyExistsError(), 'INVITATION_ALREADY_EXISTS', 409],
    [new UserAlreadyMemberError(), 'USER_ALREADY_MEMBER', 409],
    [new InvalidRoleTransitionError('test'), 'INVALID_ROLE_TRANSITION', 403],
    [new AmbiguousOrganizationSelectorError(), 'AMBIGUOUS_ORGANIZATION_SELECTOR', 400],
  ];

  it.each(cases.map(([error, code, status]) => [code, error, status]))(
    '%s expose le bon code et statut HTTP',
    (code, error, status) => {
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(error.message).toBeTruthy();
    },
  );
});
