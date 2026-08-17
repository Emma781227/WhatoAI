import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Verticales WhatsApp Business acceptées par Meta (endpoint profil). */
export const WHATSAPP_BUSINESS_VERTICALS = [
  'UNDEFINED',
  'OTHER',
  'AUTO',
  'BEAUTY',
  'APPAREL',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GROCERY',
  'GOVT',
  'HOTEL',
  'HEALTH',
  'NONPROFIT',
  'PROF_SERVICES',
  'RETAIL',
  'TRAVEL',
  'RESTAURANT',
  'NOT_A_BIZ',
] as const;

/**
 * Mise à jour du profil WhatsApp Business. Convention PATCH : champ absent
 * (`undefined`) = inchangé ; chaîne vide = effacement côté Meta. Limites alignées
 * sur Meta (about 139, address 256, description 512, email 128, 2 sites max).
 * La photo de profil n'est PAS gérée ici (Resumable Upload — hors périmètre).
 */
export class UpdateBusinessProfileDto {
  @ApiPropertyOptional({ maxLength: 139, description: 'Texte « À propos » (max 139).' })
  @IsOptional()
  @IsString()
  @MaxLength(139)
  about?: string;

  @ApiPropertyOptional({ maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @ApiPropertyOptional({ maxLength: 128, description: 'Email de contact (vide pour effacer).' })
  @IsOptional()
  // Autorise la chaîne vide (effacement) ; sinon exige un email valide.
  @ValidateIf((_, value) => value !== '')
  @IsEmail()
  @MaxLength(128)
  email?: string;

  @ApiPropertyOptional({ enum: WHATSAPP_BUSINESS_VERTICALS })
  @IsOptional()
  @IsIn(WHATSAPP_BUSINESS_VERTICALS)
  vertical?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 2, description: 'Jusqu’à 2 sites web (URL).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsUrl({}, { each: true })
  @MaxLength(256, { each: true })
  websites?: string[];
}

/** Réponse profil (lecture) — aucun secret, `profilePictureUrl` en lecture seule. */
export class BusinessProfileResponseDto {
  @ApiProperty({ nullable: true }) about!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) vertical!: string | null;
  @ApiProperty({ type: [String] }) websites!: string[];
  @ApiProperty({ nullable: true }) profilePictureUrl!: string | null;
}
