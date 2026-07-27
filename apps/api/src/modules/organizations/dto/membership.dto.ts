import { ApiProperty } from '@nestjs/swagger';
import { InvitationRole, MembershipRole, MembershipStatus } from '@whauto/database';
import { IsEnum } from 'class-validator';

import type { MemberPublic } from '../organizations.mapper';

/**
 * InvitationRole (ADMIN/MANAGER/AGENT) réutilisé volontairement : OWNER n'est
 * jamais assignable via cet endpoint, dès la validation du DTO.
 */
export class UpdateMemberRoleDto {
  @ApiProperty({ enum: InvitationRole, example: 'MANAGER' })
  @IsEnum(InvitationRole)
  role!: InvitationRole;
}

/** Identité minimale du membre — jamais de passwordHash ni de champ interne. */
export class MemberResponseDto {
  @ApiProperty()
  membershipId!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: MembershipRole })
  role!: MembershipRole;

  @ApiProperty({ enum: MembershipStatus })
  status!: MembershipStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  joinedAt!: Date;

  static fromMember(member: MemberPublic): MemberResponseDto {
    const dto = new MemberResponseDto();
    dto.membershipId = member.id;
    dto.userId = member.userId;
    dto.firstName = member.user.firstName;
    dto.lastName = member.user.lastName;
    dto.email = member.user.email;
    dto.role = member.role;
    dto.status = member.status;
    dto.joinedAt = member.joinedAt;
    return dto;
  }
}
