import { ApiProperty } from '@nestjs/swagger';
import { ConversationStatus } from '@whauto/database';
import { WHATSAPP_TEXT_MAX_LENGTH } from '@whauto/shared';
import { IsEnum, IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ maxLength: WHATSAPP_TEXT_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WHATSAPP_TEXT_MAX_LENGTH)
  text!: string;

  /**
   * Idempotence frontend : généré côté client (UUID), un retry réseau du même
   * envoi retourne le message déjà créé au lieu d'en créer un second.
   */
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  clientMessageId!: string;
}

export class AddNoteDto {
  @ApiProperty({ maxLength: WHATSAPP_TEXT_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WHATSAPP_TEXT_MAX_LENGTH)
  text!: string;
}

export class AssignConversationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  membershipId!: string;
}

export class UpdateConversationStatusDto {
  @ApiProperty({ enum: ConversationStatus })
  @IsEnum(ConversationStatus)
  status!: ConversationStatus;
}

export class AddTagDto {
  @ApiProperty({ minLength: 1, maxLength: 50 })
  @IsString()
  @Length(1, 50)
  name!: string;
}
