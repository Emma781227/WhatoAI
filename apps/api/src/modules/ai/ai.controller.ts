import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiAutoReplyService } from './ai-auto-reply.service';
import { AiConfigurationService } from './ai-configuration.service';
import { AiRunsService } from './ai-runs.service';
import { AiSuggestionsService } from './ai-suggestions.service';
import {
  AcceptSuggestionDto,
  GenerateSuggestionDto,
  RejectSuggestionDto,
  UpdateAiConfigurationDto,
} from './dto/ai.dto';

function auditContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('ai')
@ApiBearerAuth()
@Controller('organizations/:organizationId')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class AiController {
  constructor(
    private readonly configuration: AiConfigurationService,
    private readonly autoReply: AiAutoReplyService,
    private readonly suggestions: AiSuggestionsService,
    private readonly runs: AiRunsService,
  ) {}

  // ------------------------------------------------------------ configuration

  @Get('shops/:shopId/ai/configuration')
  @RequirePermissions(PERMISSIONS.AI_READ)
  @ApiOperation({ summary: 'Configuration IA de la Shop (jamais de clé/secret)' })
  getConfiguration(@CurrentTenant() tenant: TenantContext, @Param('shopId') shopId: string) {
    return this.configuration.get(tenant, shopId);
  }

  @Patch('shops/:shopId/ai/configuration')
  @RequirePermissions(PERMISSIONS.AI_CONFIGURE)
  @ApiOperation({ summary: 'Met à jour la configuration IA (AUTO_REPLY exige ai.enableAutoReply)' })
  updateConfiguration(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: UpdateAiConfigurationDto,
    @Req() req: Request,
  ) {
    return this.configuration.update(tenant, shopId, dto, auditContext(req));
  }

  // -------------------------------------------------------------- suggestions

  @Get('conversations/:conversationId/ai/suggestions')
  @RequirePermissions(PERMISSIONS.AI_READ)
  @ApiOperation({ summary: 'Suggestions IA d’une conversation (contenu seul)' })
  listSuggestions(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ) {
    return this.suggestions.list(tenant, conversationId);
  }

  @Post('conversations/:conversationId/ai/suggestions/generate')
  @RequirePermissions(PERMISSIONS.AI_SUGGEST)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Génère (idempotent) une suggestion ; forceRegenerate optionnel' })
  generate(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: GenerateSuggestionDto,
    @Req() req: Request,
  ) {
    return this.suggestions.generate(tenant, conversationId, dto.forceRegenerate ?? false, auditContext(req));
  }

  @Post('conversations/:conversationId/ai/suggestions/:suggestionId/accept')
  @RequirePermissions(PERMISSIONS.AI_ACCEPT_SUGGESTION)
  @ApiOperation({ summary: 'Accepte et ENVOIE (flux humain existant) ; envoyer=explicite' })
  accept(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() dto: AcceptSuggestionDto,
    @Req() req: Request,
  ) {
    return this.suggestions.accept(tenant, conversationId, suggestionId, dto, auditContext(req));
  }

  @Post('conversations/:conversationId/ai/suggestions/:suggestionId/reject')
  @RequirePermissions(PERMISSIONS.AI_REJECT_SUGGESTION)
  @ApiOperation({ summary: 'Rejette une suggestion PENDING (aucun message envoyé)' })
  reject(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() dto: RejectSuggestionDto,
    @Req() req: Request,
  ) {
    return this.suggestions.reject(tenant, conversationId, suggestionId, dto, auditContext(req));
  }

  // ------------------------------------------------------ auto-reply (pause)

  @Post('conversations/:conversationId/ai/auto-reply/pause')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_REPLY)
  @ApiOperation({ summary: 'Suspend l’auto-réponse IA sur cette conversation (reprise humaine)' })
  pauseAutoReply(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    return this.autoReply.pause(tenant, conversationId, auditContext(req));
  }

  @Post('conversations/:conversationId/ai/auto-reply/resume')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_REPLY)
  @ApiOperation({ summary: 'Rend la conversation à l’auto-réponse IA' })
  resumeAutoReply(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    return this.autoReply.resume(tenant, conversationId, auditContext(req));
  }

  // ---------------------------------------------------------------------- runs

  @Get('conversations/:conversationId/ai/runs')
  @RequirePermissions(PERMISSIONS.AI_READ)
  @ApiOperation({ summary: 'Runs IA (détails techniques réservés à ai.viewRuns)' })
  listRuns(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ) {
    const includeTechnical = tenant.permissions.includes(PERMISSIONS.AI_VIEW_RUNS);
    return this.runs.list(tenant, conversationId, includeTechnical);
  }
}
