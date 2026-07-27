import { ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType, ShopStatus } from '@whauto/database';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../organizations/dto/pagination.dto';

const booleanFromQuery = () =>
  Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as unknown;
  });

export class ListShopsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Recherche name/slug, insensible à la casse' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: ShopStatus, description: 'Filtre statut explicite (ARCHIVED inclus)' })
  @IsOptional()
  @IsEnum(ShopStatus)
  status?: ShopStatus;

  @ApiPropertyOptional({ enum: BusinessType })
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @booleanFromQuery()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ type: Boolean, description: 'Inclut les ARCHIVED (exclues par défaut)' })
  @IsOptional()
  @booleanFromQuery()
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: ['createdAt', 'name', 'updatedAt'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'name', 'updatedAt'])
  sortBy: 'createdAt' | 'name' | 'updatedAt' = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}
