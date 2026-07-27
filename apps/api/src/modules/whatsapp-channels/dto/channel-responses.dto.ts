import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WhatsAppChannelStatus, WhatsAppProviderType } from '@whauto/database';

import type { WhatsAppChannelPublic } from '../whatsapp-channels.mapper';

export class WhatsAppChannelResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiProperty({ enum: WhatsAppProviderType })
  provider!: WhatsAppProviderType;

  @ApiProperty({ enum: WhatsAppChannelStatus })
  status!: WhatsAppChannelStatus;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ example: '+237650000000' })
  phoneNumber!: string;

  @ApiPropertyOptional({ nullable: true })
  phoneNumberId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  wabaId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  businessId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  externalAccountId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  displayPhoneNumber!: string | null;

  @ApiPropertyOptional({ nullable: true })
  verifiedName!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  connectedAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  disconnectedAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastWebhookAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  lastErrorCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastErrorMessage!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  static fromChannel(channel: WhatsAppChannelPublic): WhatsAppChannelResponseDto {
    return Object.assign(new WhatsAppChannelResponseDto(), channel);
  }
}
