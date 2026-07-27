import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsISO31661Alpha2, IsLocale, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Convention PATCH (validée) : undefined = inchangé, null = effacement d'un
 * champ optionnel. whatsappPhone/normalizedPhone ne sont JAMAIS modifiables
 * (identité du contact) ; status est piloté par des routes dédiées futures.
 */
export class UpdateContactDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  displayName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsLocale()
  language?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO31661Alpha2()
  countryCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
