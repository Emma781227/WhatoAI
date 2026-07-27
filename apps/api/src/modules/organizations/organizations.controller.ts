import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AllowArchived } from '../../common/tenant/allow-archived.decorator';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import {
  OrganizationCreatedResponseDto,
  OrganizationDetailResponseDto,
  OrganizationMembershipResponseDto,
  OrganizationResponseDto,
} from './dto/organization-responses.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiOperation({ summary: 'Créer une organisation (devient OWNER) — email vérifié requis' })
  @ApiCreatedResponse({ type: OrganizationCreatedResponseDto })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrganizationDto,
    @Req() req: Request,
  ): Promise<OrganizationCreatedResponseDto> {
    const result = await this.organizationsService.create(user.userId, dto, actionContext(req));
    return OrganizationCreatedResponseDto.from(result);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Organisations où je suis membre actif (statut visible, y compris archivées)' })
  @ApiOkResponse({ type: [OrganizationMembershipResponseDto] })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<OrganizationMembershipResponseDto[]> {
    const summaries = await this.organizationsService.listForUser(user.userId);
    return summaries.map((summary) => OrganizationMembershipResponseDto.from(summary));
  }

  @Get(':organizationId')
  @UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
  @AllowArchived()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  @ApiOperation({ summary: 'Détail d’une organisation (lecture seule autorisée si archivée)' })
  @ApiOkResponse({ type: OrganizationDetailResponseDto })
  async get(@CurrentTenant() tenant: TenantContext): Promise<OrganizationDetailResponseDto> {
    const { organization, memberCount } = await this.organizationsService.getForTenant(tenant);
    return OrganizationDetailResponseDto.fromDetail(organization, tenant, memberCount);
  }

  @Patch(':organizationId')
  @UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  @ApiOperation({ summary: 'Modifier une organisation (name, slug, timezone, devise, locale)' })
  @ApiOkResponse({ type: OrganizationResponseDto })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: UpdateOrganizationDto,
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizationsService.update(tenant, dto, actionContext(req));
    return OrganizationResponseDto.fromOrganization(organization);
  }

  @Post(':organizationId/archive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.ORGANIZATION_ARCHIVE)
  @ApiOperation({ summary: 'Archiver l’organisation (OWNER uniquement, logique et définitif pour cette phase)' })
  @ApiOkResponse({ type: OrganizationResponseDto })
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.organizationsService.archive(tenant, actionContext(req));
    return OrganizationResponseDto.fromOrganization(organization);
  }
}
