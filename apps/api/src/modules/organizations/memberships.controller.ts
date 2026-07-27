import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MemberResponseDto, UpdateMemberRoleDto } from './dto/membership.dto';
import { PaginatedResponseDto, PaginationQueryDto } from './dto/pagination.dto';
import { MembershipsService } from './memberships.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('members')
@ApiBearerAuth()
@Controller('organizations/:organizationId')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get('members')
  @RequirePermissions(PERMISSIONS.MEMBERS_READ)
  @ApiOperation({ summary: 'Membres actifs de l’organisation (paginés)' })
  @ApiOkResponse({ type: PaginatedResponseDto<MemberResponseDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MemberResponseDto>> {
    const { items, total } = await this.membershipsService.list(tenant, pagination);
    return PaginatedResponseDto.of(
      items.map((member) => MemberResponseDto.fromMember(member)),
      total,
      pagination,
    );
  }

  @Patch('members/:membershipId/role')
  @RequirePermissions(PERMISSIONS.MEMBERS_UPDATE_ROLE)
  @ApiOperation({
    summary: 'Changer le rôle d’un membre (hiérarchie stricte, OWNER intouchable)',
  })
  @ApiOkResponse({ type: MemberResponseDto })
  async updateRole(
    @CurrentTenant() tenant: TenantContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: Request,
  ): Promise<MemberResponseDto> {
    const member = await this.membershipsService.updateRole(
      tenant,
      membershipId,
      dto.role,
      actionContext(req),
    );
    return MemberResponseDto.fromMember(member);
  }

  @Delete('members/:membershipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSIONS.MEMBERS_REMOVE)
  @ApiOperation({ summary: 'Retirer un membre (passe en LEFT, OWNER non retirable)' })
  @ApiNoContentResponse()
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('membershipId') membershipId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.membershipsService.remove(tenant, membershipId, actionContext(req));
  }

  @Post('leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitter l’organisation (interdit à l’OWNER)' })
  @ApiNoContentResponse()
  async leave(@CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<void> {
    await this.membershipsService.leave(tenant, actionContext(req));
  }
}
