import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ConnectMetaChannelDto {
  @ApiPropertyOptional({ description: 'Libellé du canal (défaut : nom vérifié Meta).' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName?: string;
}

/**
 * Envoi de test RÉEL — action explicite (validé D19) : `confirm` DOIT valoir
 * true, sinon l'envoi est refusé. Diagnostic de connectivité, distinct du
 * health (qui n'envoie jamais).
 */
export class SendTestMessageDto {
  @ApiProperty({ description: 'Destinataire au format international (E.164).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  to!: string;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  text!: string;

  @ApiProperty({ description: 'Confirmation explicite requise (doit valoir true).' })
  @IsBoolean()
  @Equals(true)
  confirm!: boolean;
}

/**
 * Embedded Signup : le frontend transmet le `code` OAuth renvoyé par Meta + les
 * identifiants sélectionnés (WABA, numéro, business). Le backend échange le code,
 * abonne l'App et provisionne la connexion. AUCUN token n'est transmis par le
 * frontend (le token est obtenu et chiffré côté serveur).
 */
export class EmbeddedSignupDto {
  @ApiProperty({ description: 'Code d’autorisation OAuth renvoyé par l’Embedded Signup Meta.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  code!: string;

  @ApiProperty({ description: 'WhatsApp Business Account id (WABA).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  wabaId!: string;

  @ApiProperty({ description: 'Phone Number ID Meta du numéro sélectionné.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  phoneNumberId!: string;

  @ApiProperty({ description: 'Meta Business (Business Manager) id.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  businessId!: string;
}

export class MetaChannelHealthResponseDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty() provider!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ nullable: true }) phoneNumberId!: string | null;
  @ApiPropertyOptional({ nullable: true }) displayPhoneNumber!: string | null;
  @ApiPropertyOptional({ nullable: true }) verifiedName!: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastWebhookAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) lastErrorCode!: string | null;
}

export class SendTestMessageResponseDto {
  @ApiProperty() sent!: boolean;
  @ApiProperty() providerMessageId!: string;
}
