import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

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
import { InviteMemberDto, InvitationTokenDto } from './dto/invitation.dto';
import {
  InvitationAcceptedResponseDto,
  InvitationCreatedResponseDto,
  InvitationResponseDto,
  MyInvitationResponseDto,
} from './dto/invitation-responses.dto';
import { PaginatedResponseDto, PaginationQueryDto } from './dto/pagination.dto';
import { InvitationsService } from './invitations.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('invitations')
@ApiBearerAuth()
@Controller('organizations/:organizationId/invitations')
export class OrganizationInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.MEMBERS_INVITE)
  @ApiOperation({
    summary: 'Inviter un membre (ADMIN/MANAGER/AGENT) — renouvelle l’invitation PENDING existante',
  })
  @ApiCreatedResponse({ type: InvitationCreatedResponseDto })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: InviteMemberDto,
    @Req() req: Request,
  ): Promise<InvitationCreatedResponseDto> {
    const result = await this.invitationsService.createOrResend(tenant, dto, actionContext(req));
    return InvitationCreatedResponseDto.from(result);
  }

  @Get()
  @UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.INVITATIONS_READ)
  @ApiOperation({ summary: 'Invitations de l’organisation (paginées, tokenHash jamais exposé)' })
  @ApiOkResponse({ type: PaginatedResponseDto<InvitationResponseDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<InvitationResponseDto>> {
    const { items, total } = await this.invitationsService.listForOrganization(tenant, pagination);
    return PaginatedResponseDto.of(
      items.map((item) => InvitationResponseDto.fromInvitation(item)),
      total,
      pagination,
    );
  }

  @Post(':invitationId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.INVITATIONS_CANCEL)
  @ApiOperation({ summary: 'Annuler une invitation PENDING de l’organisation' })
  @ApiNoContentResponse()
  async cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param('invitationId') invitationId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.invitationsService.cancel(tenant, invitationId, actionContext(req));
  }
}

@ApiTags('invitations')
@ApiBearerAuth()
@Controller('invitations')
export class MyInvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Mes invitations PENDING (adressées à l’email de mon compte)' })
  @ApiOkResponse({ type: [MyInvitationResponseDto] })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<MyInvitationResponseDto[]> {
    const invitations = await this.invitationsService.listMine(user.userId);
    return invitations.map((invitation) => MyInvitationResponseDto.fromMine(invitation));
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @ApiOperation({ summary: 'Accepter une invitation (email vérifié et correspondant requis)' })
  @ApiOkResponse({ type: InvitationAcceptedResponseDto })
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InvitationTokenDto,
    @Req() req: Request,
  ): Promise<InvitationAcceptedResponseDto> {
    const result = await this.invitationsService.accept(user.userId, dto.token, actionContext(req));
    return InvitationAcceptedResponseDto.from(result);
  }

  @Post('decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Refuser une invitation (email du compte correspondant requis)' })
  @ApiNoContentResponse()
  async decline(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InvitationTokenDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.invitationsService.decline(user.userId, dto.token, actionContext(req));
  }
}
