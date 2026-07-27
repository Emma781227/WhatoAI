import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvitationRole, InvitationStatus, MembershipRole } from '@whauto/database';

import type { InvitationPublic } from '../organizations.mapper';
import { OrganizationResponseDto } from './organization-responses.dto';
import type { OrganizationPublic } from '../organizations.mapper';

/** tokenHash exclu par construction (jamais sélectionné, jamais mappé). */
export class InvitationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: InvitationRole })
  role!: InvitationRole;

  @ApiProperty({
    enum: InvitationStatus,
    description: 'Statut effectif : une PENDING expirée est présentée EXPIRED',
  })
  status!: InvitationStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  static fromInvitation(invitation: InvitationPublic): InvitationResponseDto {
    const dto = new InvitationResponseDto();
    dto.id = invitation.id;
    dto.organizationId = invitation.organizationId;
    dto.email = invitation.email;
    dto.role = invitation.role;
    dto.status = invitation.status;
    dto.expiresAt = invitation.expiresAt;
    dto.createdAt = invitation.createdAt;
    return dto;
  }
}

export class InvitationCreatedResponseDto {
  @ApiProperty({ type: InvitationResponseDto })
  invitation!: InvitationResponseDto;

  @ApiProperty({ description: 'true si une invitation PENDING existante a été renouvelée' })
  resent!: boolean;

  @ApiPropertyOptional({
    description:
      "Lien d'acceptation — présent uniquement en development avec AUTH_EXPOSE_TEST_TOKENS=true",
  })
  devLink?: string;

  static from(input: {
    invitation: InvitationPublic;
    resent: boolean;
    devLink?: string;
  }): InvitationCreatedResponseDto {
    const dto = new InvitationCreatedResponseDto();
    dto.invitation = InvitationResponseDto.fromInvitation(input.invitation);
    dto.resent = input.resent;
    if (input.devLink !== undefined) {
      dto.devLink = input.devLink;
    }
    return dto;
  }
}

class InvitationOrganizationSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;
}

/** GET /invitations/mine : le token n'est jamais renvoyé — il n'existe que dans l'email reçu. */
export class MyInvitationResponseDto extends InvitationResponseDto {
  @ApiProperty({ type: InvitationOrganizationSummaryDto })
  organization!: InvitationOrganizationSummaryDto;

  static fromMine(
    invitation: InvitationPublic & { organization: { id: string; name: string; slug: string } },
  ): MyInvitationResponseDto {
    const dto = Object.assign(
      new MyInvitationResponseDto(),
      InvitationResponseDto.fromInvitation(invitation),
    );
    dto.organization = {
      id: invitation.organization.id,
      name: invitation.organization.name,
      slug: invitation.organization.slug,
    };
    return dto;
  }
}

export class InvitationAcceptedResponseDto {
  @ApiProperty({ type: OrganizationResponseDto })
  organization!: OrganizationResponseDto;

  @ApiProperty()
  membershipId!: string;

  @ApiProperty({ enum: MembershipRole })
  role!: MembershipRole;

  static from(input: {
    organization: OrganizationPublic;
    membershipId: string;
    role: MembershipRole;
  }): InvitationAcceptedResponseDto {
    const dto = new InvitationAcceptedResponseDto();
    dto.organization = OrganizationResponseDto.fromOrganization(input.organization);
    dto.membershipId = input.membershipId;
    dto.role = input.role;
    return dto;
  }
}
