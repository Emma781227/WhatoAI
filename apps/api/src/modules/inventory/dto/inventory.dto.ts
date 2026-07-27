import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryMovementType } from '@whauto/database';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { StockStatus } from '@whauto/shared';

import { PaginationQueryDto } from '../../organizations/dto/pagination.dto';

/**
 * DTO discriminé (décision validée) :
 * - RESTOCK : quantité POSITIVE reçue → delta POSITIF stocké ;
 * - DAMAGE  : quantité POSITIVE reçue → delta NÉGATIF stocké ;
 * - ADJUSTMENT : quantité CIBLE (newQuantityOnHand) + raison obligatoire +
 *   expectedVersion (verrou optimiste) → delta stocké = after − before.
 */
export class AdjustInventoryDto {
  @ApiProperty({ enum: ['ADJUSTMENT', 'RESTOCK', 'DAMAGE'] })
  @IsIn(['ADJUSTMENT', 'RESTOCK', 'DAMAGE'])
  type!: 'ADJUSTMENT' | 'RESTOCK' | 'DAMAGE';

  @ApiPropertyOptional({ description: 'RESTOCK/DAMAGE : quantité positive.', minimum: 1 })
  @ValidateIf((dto: AdjustInventoryDto) => dto.type === 'RESTOCK' || dto.type === 'DAMAGE')
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity?: number;

  @ApiPropertyOptional({ description: 'ADJUSTMENT : quantité cible (>= 0).', minimum: 0 })
  @ValidateIf((dto: AdjustInventoryDto) => dto.type === 'ADJUSTMENT')
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  newQuantityOnHand?: number;

  @ApiPropertyOptional({ description: 'ADJUSTMENT : version lue (verrou optimiste).' })
  @ValidateIf((dto: AdjustInventoryDto) => dto.type === 'ADJUSTMENT')
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;

  @ApiPropertyOptional({ description: 'Obligatoire pour ADJUSTMENT et DAMAGE.' })
  @ValidateIf((dto: AdjustInventoryDto) => dto.type === 'ADJUSTMENT' || dto.type === 'DAMAGE')
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'RESTOCK : raison facultative.' })
  @ValidateIf((dto: AdjustInventoryDto) => dto.type === 'RESTOCK')
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  restockReason?: string;
}

export class ListInventoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Recherche produit (nom) ou SKU.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'] })
  @IsOptional()
  @IsIn(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'])
  stockStatus?: StockStatus;

  @ApiPropertyOptional({ description: 'Inclure les variantes archivées (exclues par défaut).' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeArchived?: boolean;
}

export class InventoryRowDto {
  @ApiProperty()
  variantId!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiPropertyOptional({ nullable: true })
  variantName!: string | null;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  priceMinor!: number;

  @ApiProperty()
  quantityOnHand!: number;

  @ApiProperty()
  quantityReserved!: number;

  @ApiProperty({ description: 'onHand − reserved ; peut être négatif (backorder).' })
  quantityAvailable!: number;

  @ApiProperty()
  lowStockThreshold!: number;

  @ApiProperty()
  allowBackorder!: boolean;

  @ApiProperty()
  trackInventory!: boolean;

  @ApiProperty({ description: 'Verrou optimiste pour les ADJUSTMENT.' })
  version!: number;

  @ApiProperty({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'] })
  stockStatus!: StockStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class MovementResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  variantId!: string;

  @ApiProperty({ enum: InventoryMovementType })
  type!: InventoryMovementType;

  @ApiProperty({ description: 'Delta RÉELLEMENT appliqué, signé.' })
  quantityDelta!: number;

  @ApiProperty()
  quantityBefore!: number;

  @ApiProperty()
  quantityAfter!: number;

  @ApiPropertyOptional({ nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ nullable: true })
  referenceType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  referenceId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  actor!: { id: string; firstName: string; lastName: string } | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
