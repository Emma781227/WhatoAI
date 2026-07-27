import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType, ShopStatus } from '@whauto/database';

import type { ShopPublic } from '../shops.mapper';

export class ShopResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: ShopStatus })
  status!: ShopStatus;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiPropertyOptional({ enum: BusinessType, nullable: true })
  businessType!: BusinessType | null;

  @ApiPropertyOptional({ nullable: true })
  logoUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  coverUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  websiteUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  supportEmail!: string | null;

  @ApiPropertyOptional({ nullable: true })
  supportPhone!: string | null;

  @ApiPropertyOptional({ nullable: true })
  addressLine1!: string | null;

  @ApiPropertyOptional({ nullable: true })
  addressLine2!: string | null;

  @ApiPropertyOptional({ nullable: true })
  city!: string | null;

  @ApiPropertyOptional({ nullable: true })
  region!: string | null;

  @ApiPropertyOptional({ nullable: true })
  postalCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  latitude!: number | null;

  @ApiPropertyOptional({ nullable: true })
  longitude!: number | null;

  @ApiProperty({ example: 'CM' })
  countryCode!: string;

  @ApiProperty({ example: 'Africa/Douala' })
  timezone!: string;

  @ApiProperty({ example: 'XAF' })
  currency!: string;

  @ApiProperty({ example: 'fr' })
  locale!: string;

  @ApiPropertyOptional({ nullable: true })
  returnPolicy!: string | null;

  @ApiPropertyOptional({ nullable: true })
  deliveryPolicy!: string | null;

  @ApiPropertyOptional({ nullable: true })
  orderInstructions!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  archivedAt!: Date | null;

  static fromShop(shop: ShopPublic): ShopResponseDto {
    return Object.assign(new ShopResponseDto(), shop);
  }
}
