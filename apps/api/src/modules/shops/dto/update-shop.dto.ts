import { ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType } from '@whauto/database';
import {
  IsEmail,
  IsEnum,
  IsISO4217CurrencyCode,
  IsISO31661Alpha2,
  IsLatitude,
  IsLocale,
  IsLongitude,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Applique les validateurs seulement si le champ est présent — null REFUSÉ (champ non effaçable). */
const WhenDefined = () => ValidateIf((_object, value) => value !== undefined);

const POLICY_MAX_LENGTH = 2000;

/**
 * Convention PATCH (validée, voir CLAUDE.md) :
 * - `undefined` (champ absent) = inchangé ;
 * - `null` = effacement, uniquement pour les champs optionnels (@IsOptional
 *   accepte null) — les champs requis utilisent WhenDefined et refusent null.
 * organizationId, isPrimary, status, archivedAt, createdByUserId ne sont
 * jamais acceptés (routes dédiées + whitelist globale).
 */
export class UpdateShopDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 100 })
  @WhenDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @WhenDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase letters, digits and single hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ enum: BusinessType, nullable: true })
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  coverUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  websiteUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  supportEmail?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+237650000000' })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ().-]{6,20}$/, { message: 'supportPhone must be a plausible phone number' })
  supportPhone?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsLatitude()
  latitude?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsLongitude()
  longitude?: number | null;

  @ApiPropertyOptional({ example: 'CM' })
  @WhenDefined()
  @IsISO31661Alpha2()
  countryCode?: string;

  @ApiPropertyOptional({ example: 'Africa/Douala' })
  @WhenDefined()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ example: 'XAF' })
  @WhenDefined()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: 'fr' })
  @WhenDefined()
  @IsLocale()
  locale?: string;

  @ApiPropertyOptional({ maxLength: POLICY_MAX_LENGTH, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_MAX_LENGTH)
  returnPolicy?: string | null;

  @ApiPropertyOptional({ maxLength: POLICY_MAX_LENGTH, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_MAX_LENGTH)
  deliveryPolicy?: string | null;

  @ApiPropertyOptional({ maxLength: POLICY_MAX_LENGTH, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_MAX_LENGTH)
  orderInstructions?: string | null;
}
