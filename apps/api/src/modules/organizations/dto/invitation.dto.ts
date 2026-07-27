import { ApiProperty } from '@nestjs/swagger';
import { InvitationRole } from '@whauto/database';
import { IsEmail, IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * InvitationRole (ADMIN/MANAGER/AGENT) et non MembershipRole : une invitation
 * OWNER est impossible dès la validation, et l'enum PostgreSQL la rejette aussi.
 */
export class InviteMemberDto {
  @ApiProperty({ example: 'fatou@boutique.cm' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ enum: InvitationRole, example: 'AGENT' })
  @IsEnum(InvitationRole)
  role!: InvitationRole;
}

export class InvitationTokenDto {
  @ApiProperty({ description: 'Token opaque reçu par email' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;
}
