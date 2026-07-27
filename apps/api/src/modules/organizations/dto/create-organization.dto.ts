import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO4217CurrencyCode,
  IsLocale,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Boutique Aïcha', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 'boutique-aicha',
    description: 'Généré depuis le nom si absent. Minuscules, chiffres, tirets simples.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase letters, digits and single hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ example: 'Africa/Douala', description: 'Fuseau IANA' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ example: 'XAF', description: 'Code devise ISO 4217' })
  @IsOptional()
  @IsISO4217CurrencyCode()
  defaultCurrency?: string;

  @ApiPropertyOptional({ example: 'fr', description: 'Locale BCP 47' })
  @IsOptional()
  @IsLocale()
  defaultLocale?: string;
}
