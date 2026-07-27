import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType } from '@whauto/database';
import {
  IsEnum,
  IsISO4217CurrencyCode,
  IsISO31661Alpha2,
  IsLocale,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Validateurs régionaux : compatibilité vérifiée avec class-validator 0.14.4
 * installé (IsTimeZone, IsISO4217CurrencyCode, IsISO31661Alpha2 présents) —
 * pas de validateurs personnalisés nécessaires.
 * organizationId, isPrimary, status, createdByUserId ne sont JAMAIS acceptés
 * ici (whitelist + forbidNonWhitelisted globaux).
 */
export class CreateShopDto {
  @ApiProperty({ example: 'Boutique Centre-Ville', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'boutique-centre-ville', description: 'Généré depuis le nom si absent' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase letters, digits and single hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: BusinessType })
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @ApiProperty({ example: 'CM', description: 'ISO 3166-1 alpha-2 — requis, jamais déduit de la devise' })
  @IsISO31661Alpha2()
  countryCode!: string;

  @ApiPropertyOptional({ example: 'Africa/Douala', description: "Hérité de l'organisation si absent" })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ example: 'XAF', description: "Héritée de l'organisation si absente" })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: 'fr', description: "Héritée de l'organisation si absente" })
  @IsOptional()
  @IsLocale()
  locale?: string;
}
