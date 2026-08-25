import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WHATSAPP_TEXT_MAX_LENGTH } from '@whauto/shared';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class MockInboundDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  channelId!: string;

  @ApiProperty({ example: '+237650123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiProperty({ maxLength: WHATSAPP_TEXT_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WHATSAPP_TEXT_MAX_LENGTH)
  text!: string;

  @ApiPropertyOptional({ description: 'Fourni = test d’idempotence (relivraison).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalMessageId?: string;

  /**
   * Simule un média entrant : `text` devient alors la LÉGENDE. Le fichier
   * lui-même est servi par le stockage mock du worker — aucun appel réseau.
   */
  @ApiPropertyOptional({ enum: ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER'] })
  @IsOptional()
  @IsIn(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER'])
  mediaType?: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER';

  @ApiPropertyOptional({ description: 'Identifiant de média simulé (défaut : généré).' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mediaId?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  mediaMimeType?: string;

  @ApiPropertyOptional({ example: 'bon-de-commande.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  mediaFileName?: string;
}

export class MockStatusDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  channelId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  externalMessageId!: string;

  @ApiProperty({ enum: ['DELIVERED', 'READ', 'FAILED'] })
  @IsIn(['DELIVERED', 'READ', 'FAILED'])
  status!: 'DELIVERED' | 'READ' | 'FAILED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  errorCode?: string;
}
