import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContactStatus } from '@whauto/database';

import type { ContactPublic } from '../contacts.mapper';

export class ContactResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiPropertyOptional({ nullable: true })
  externalId!: string | null;

  @ApiProperty({ example: '+237650123456' })
  whatsappPhone!: string;

  @ApiProperty({ example: '+237650123456' })
  normalizedPhone!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  profilePictureUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true })
  language!: string | null;

  @ApiPropertyOptional({ nullable: true })
  city!: string | null;

  @ApiPropertyOptional({ nullable: true })
  countryCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  notes!: string | null;

  @ApiProperty({ enum: ContactStatus })
  status!: ContactStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  lastActivityAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  static fromContact(contact: ContactPublic): ContactResponseDto {
    return Object.assign(new ContactResponseDto(), contact);
  }
}
