import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole, OrganizationStatus } from '@whauto/database';

import type { Permission } from '../../../common/tenant/permissions';
import type { TenantContext } from '../../../common/tenant/tenant-context.interface';
import type { OrganizationPublic } from '../organizations.mapper';

export class OrganizationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ enum: OrganizationStatus })
  status!: OrganizationStatus;

  @ApiProperty({ example: 'Africa/Douala' })
  timezone!: string;

  @ApiProperty({ example: 'XAF' })
  defaultCurrency!: string;

  @ApiProperty({ example: 'fr' })
  defaultLocale!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  static fromOrganization(organization: OrganizationPublic): OrganizationResponseDto {
    const dto = new OrganizationResponseDto();
    dto.id = organization.id;
    dto.name = organization.name;
    dto.slug = organization.slug;
    dto.status = organization.status;
    dto.timezone = organization.timezone;
    dto.defaultCurrency = organization.defaultCurrency;
    dto.defaultLocale = organization.defaultLocale;
    dto.createdAt = organization.createdAt;
    dto.updatedAt = organization.updatedAt;
    return dto;
  }
}

/** Élément de GET /organizations : l'organisation + le lien de l'utilisateur avec elle. */
export class OrganizationMembershipResponseDto {
  @ApiProperty({ type: OrganizationResponseDto })
  organization!: OrganizationResponseDto;

  @ApiProperty()
  membershipId!: string;

  @ApiProperty({ enum: MembershipRole })
  role!: MembershipRole;

  @ApiProperty({ type: String, format: 'date-time' })
  joinedAt!: Date;

  static from(input: {
    organization: OrganizationPublic;
    membershipId: string;
    role: string;
    joinedAt: Date;
  }): OrganizationMembershipResponseDto {
    const dto = new OrganizationMembershipResponseDto();
    dto.organization = OrganizationResponseDto.fromOrganization(input.organization);
    dto.membershipId = input.membershipId;
    dto.role = input.role as MembershipRole;
    dto.joinedAt = input.joinedAt;
    return dto;
  }
}

/** Détail de GET /organizations/:id : rôle et permissions effectives du demandeur incluses. */
export class OrganizationDetailResponseDto extends OrganizationResponseDto {
  @ApiProperty({ enum: MembershipRole })
  role!: MembershipRole;

  @ApiProperty({ type: [String], example: ['organization.read', 'members.read'] })
  permissions!: readonly Permission[];

  @ApiProperty()
  memberCount!: number;

  static fromDetail(
    organization: OrganizationPublic,
    tenant: TenantContext,
    memberCount: number,
  ): OrganizationDetailResponseDto {
    const dto = Object.assign(
      new OrganizationDetailResponseDto(),
      OrganizationResponseDto.fromOrganization(organization),
    );
    dto.role = tenant.role;
    dto.permissions = tenant.permissions;
    dto.memberCount = memberCount;
    return dto;
  }
}

/** Réponse de POST /organizations : l'organisation + le Membership OWNER créé. */
export class OrganizationCreatedResponseDto {
  @ApiProperty({ type: OrganizationResponseDto })
  organization!: OrganizationResponseDto;

  @ApiProperty()
  membershipId!: string;

  @ApiProperty({ enum: MembershipRole, example: 'OWNER' })
  role!: MembershipRole;

  static from(input: {
    organization: OrganizationPublic;
    membershipId: string;
    role: MembershipRole;
  }): OrganizationCreatedResponseDto {
    const dto = new OrganizationCreatedResponseDto();
    dto.organization = OrganizationResponseDto.fromOrganization(input.organization);
    dto.membershipId = input.membershipId;
    dto.role = input.role;
    return dto;
  }
}
