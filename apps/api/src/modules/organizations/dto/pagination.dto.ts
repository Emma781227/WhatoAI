import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Convention validée : page/limit (défauts 1/20, limite max 100). */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export class PaginatedResponseDto<TItem> {
  items!: TItem[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  static of<TItem>(
    items: TItem[],
    total: number,
    query: PaginationQueryDto,
  ): PaginatedResponseDto<TItem> {
    const dto = new PaginatedResponseDto<TItem>();
    dto.items = items;
    dto.total = total;
    dto.page = query.page;
    dto.limit = query.limit;
    return dto;
  }
}
