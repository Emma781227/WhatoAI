import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AI_AUTO_REPLY_CATEGORIES } from '@whauto/shared';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
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

// ------------------------------------------------------------------ requests

/**
 * PATCH configuration IA. `undefined` = inchangé. Activer AUTO_REPLY (mode ou
 * `autoReplyEnabled`) exige la permission `ai.enableAutoReply` (voir service) ;
 * les garde-fous (schedule/plafond/catégories) sont configurables par ai.configure.
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

  /**
   * Outils WRITE panier de l'assistant (AI-C / W3). Activé par défaut : le
   * panier est réversible et corrigeable par un agent. false = l'assistant
   * redevient strictement en lecture (prompt ET outils).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  cartToolsEnabled?: boolean;

  /** Activation AUTO_REPLY — exige la permission ai.enableAutoReply (voir service). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  /** Couverture de l'auto-réponse : 24/7 ou uniquement hors horaires d'ouverture. */
  @ApiPropertyOptional({ enum: ['ALWAYS', 'OUTSIDE_BUSINESS_HOURS'] })
  @IsOptional()
  @IsIn(['ALWAYS', 'OUTSIDE_BUSINESS_HOURS'])
  autoReplyScheduleMode?: 'ALWAYS' | 'OUTSIDE_BUSINESS_HOURS';

  /** Plafond de réponses automatiques par conversation et par jour. */
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  autoReplyMaxPerConversationPerDay?: number;

  /** Liste blanche des catégories auto-envoyables (déterministe, par outils). */
  @ApiPropertyOptional({ enum: AI_AUTO_REPLY_CATEGORIES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn([...AI_AUTO_REPLY_CATEGORIES], { each: true })
  @ArrayUnique()
  autoReplyAllowedCategories?: string[];

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
  @ApiProperty() autoReplyScheduleMode!: string;
  @ApiProperty() autoReplyMaxPerConversationPerDay!: number;
  @ApiProperty({ type: [String] }) autoReplyAllowedCategories!: string[];
  @ApiProperty() humanHandoffEnabled!: boolean;
  @ApiProperty() cartToolsEnabled!: boolean;
  @ApiProperty() version!: number;
}

/** Réponse pause/reprise de l'auto-réponse d'une conversation. */
export class AiAutoReplyStateDto {
  @ApiProperty() conversationId!: string;
  @ApiProperty() mode!: string;
  @ApiProperty() aiAutoReplyPaused!: boolean;
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
