import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

// ------------------------------------------------------------------ requests

/**
 * PATCH configuration IA. `undefined` = inchangé. AUTO_REPLY n'est PAS activable
 * fonctionnellement dans cette phase : `mode` est borné à DISABLED/SUGGEST_ONLY,
 * et `autoReplyEnabled` refusé (voir service — permission ai.enableAutoReply).
 */
export class UpdateAiConfigurationDto {
  @ApiPropertyOptional({ enum: ['MOCK', 'GEMINI'] })
  @IsOptional()
  @IsString()
  provider?: 'MOCK' | 'GEMINI';

  @ApiPropertyOptional({ enum: ['DISABLED', 'SUGGEST_ONLY', 'AUTO_REPLY'] })
  @IsOptional()
  @IsString()
  mode?: 'DISABLED' | 'SUGGEST_ONLY' | 'AUTO_REPLY';

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  model?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(4000)
  systemPromptOverride?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 8192 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  maxOutputTokens?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  contextMaxMessages?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  toolMaxRounds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  humanHandoffEnabled?: boolean;

  /** Réservé — exige ai.enableAutoReply ET reste sans effet fonctionnel ici. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class GenerateSuggestionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  forceRegenerate?: boolean;
}

export class AcceptSuggestionDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  content!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  confirmStale?: boolean;
}

export class RejectSuggestionDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// ----------------------------------------------------------------- responses

/**
 * Configuration IA renvoyée — jamais de clé API, jamais de secret. Le prompt
 * override N'EST renvoyé qu'à titre de configuration (contenu défini par la Shop
 * elle-même, pas un secret système).
 */
export class AiConfigurationResponseDto {
  @ApiProperty() shopId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() mode!: string;
  @ApiProperty({ nullable: true }) model!: string | null;
  @ApiProperty() maxOutputTokens!: number;
  @ApiProperty() contextMaxMessages!: number;
  @ApiProperty() toolMaxRounds!: number;
  @ApiProperty() autoReplyEnabled!: boolean;
  @ApiProperty() humanHandoffEnabled!: boolean;
  @ApiProperty() version!: number;
}

/** Suggestion renvoyée — contenu de la suggestion uniquement, aucun détail run. */
export class AiSuggestionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true }) content!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() contextLastMessageId!: string;
  @ApiProperty({ nullable: true }) sentMessageId!: string | null;
  @ApiProperty() createdAt!: string;
}

/**
 * Run renvoyé — DÉTAILS TECHNIQUES (tokens, modèle, tool rounds) réservés à
 * ai.viewRuns ; jamais de prompt, de payload Gemini brut ni de résultat d'outil
 * complet.
 */
export class AiRunResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() mode!: string;
  @ApiProperty({ nullable: true }) provider!: string | null;
  @ApiProperty({ nullable: true }) inputTokens!: number | null;
  @ApiProperty({ nullable: true }) outputTokens!: number | null;
  @ApiProperty({ nullable: true }) totalTokens!: number | null;
  @ApiProperty({ nullable: true }) toolRounds!: number | null;
  @ApiProperty({ nullable: true }) resolvedModel!: string | null;
  @ApiProperty({ nullable: true }) errorCode!: string | null;
  @ApiProperty() createdAt!: string;
}
