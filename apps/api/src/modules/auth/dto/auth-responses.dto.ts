import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@whauto/database';

import type { UserPublic } from '../auth.mapper';

/**
 * DTO de réponse construits par mapper explicite (jamais par sérialisation
 * directe d'une entité Prisma) : seuls les champs déclarés ici sortent de l'API.
 */
export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  static fromUser(user: UserPublic): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.firstName = user.firstName;
    dto.lastName = user.lastName;
    dto.status = user.status;
    dto.emailVerifiedAt = user.emailVerifiedAt;
    dto.createdAt = user.createdAt;
    return dto;
  }
}

/**
 * Contrat pour apps/web : l'access token arrive dans ce JSON et doit rester
 * en mémoire uniquement (jamais localStorage/sessionStorage). Le refresh token
 * n'apparaît jamais dans le JSON — il est posé en cookie HttpOnly par l'API.
 */
export class AuthSessionResponseDto {
  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;

  @ApiProperty({ description: 'JWT access token (15 min) — à garder en mémoire côté client' })
  accessToken!: string;

  static from(user: UserPublic, accessToken: string): AuthSessionResponseDto {
    const dto = new AuthSessionResponseDto();
    dto.user = UserResponseDto.fromUser(user);
    dto.accessToken = accessToken;
    return dto;
  }
}

export class MessageResponseDto {
  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({
    description:
      'Lien de vérification/reset — présent uniquement en development avec AUTH_EXPOSE_TEST_TOKENS=true',
  })
  devLink?: string;

  static from(result: { message: string; devLink?: string }): MessageResponseDto {
    const dto = new MessageResponseDto();
    dto.message = result.message;
    if (result.devLink !== undefined) {
      dto.devLink = result.devLink;
    }
    return dto;
  }
}

export class LogoutAllResponseDto {
  @ApiProperty({ description: 'Nombre de sessions révoquées' })
  revokedSessions!: number;
}
