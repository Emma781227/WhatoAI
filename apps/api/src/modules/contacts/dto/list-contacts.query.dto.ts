import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContactStatus } from '@whauto/database';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../organizations/dto/pagination.dto';

export class ListContactsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Restreindre à une Shop.' })
  @IsOptional()
  @IsString()
  shopId?: string;

  @ApiPropertyOptional({ description: 'Recherche nom/téléphone (insensible à la casse).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: ContactStatus })
  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;
}
