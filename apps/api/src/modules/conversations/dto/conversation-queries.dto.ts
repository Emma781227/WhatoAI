import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationPriority, ConversationStatus } from '@whauto/database';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListConversationsQueryDto {
  @ApiPropertyOptional({ description: 'Curseur keyset opaque (réponse précédente).' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shopId?: string;

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ enum: ConversationPriority })
  @IsOptional()
  @IsEnum(ConversationPriority)
  priority?: ConversationPriority;

  @ApiPropertyOptional({ description: 'Conversations assignées à ce membership.' })
  @IsOptional()
  @IsString()
  assignedMembershipId?: string;

  @ApiPropertyOptional({ description: 'true = uniquement les non assignées.' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  unassigned?: boolean;

  @ApiPropertyOptional({ description: 'true = uniquement unreadCount > 0.' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  unreadOnly?: boolean;

  @ApiPropertyOptional({ description: 'Recherche contact (nom ou téléphone).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ type: [String], description: 'Ids de tags (ET logique).' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Curseur keyset opaque (réponse précédente).' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}
