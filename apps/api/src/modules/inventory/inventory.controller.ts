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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginatedResponseDto, PaginationQueryDto } from '../organizations/dto/pagination.dto';
import {
  AdjustInventoryDto,
  InventoryRowDto,
  ListInventoryQueryDto,
  MovementResponseDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

class AdjustResponseDto {
  @ApiProperty({ type: InventoryRowDto })
  inventory!: InventoryRowDto;

  @ApiProperty({ description: 'Mouvement créé (delta réellement appliqué, signé).' })
  movement!: {
    type: string;
    quantityDelta: number;
    quantityBefore: number;
    quantityAfter: number;
  };
}

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops/:shopId')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('inventory')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary:
      'Stock de la Shop — filtre stockStatus (faible/rupture) appliqué en SQL avant pagination',
  })
  @ApiOkResponse({ type: PaginatedResponseDto<InventoryRowDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Query() query: ListInventoryQueryDto,
  ): Promise<PaginatedResponseDto<InventoryRowDto>> {
    const { items, total } = await this.inventoryService.list(tenant, shopId, query);
    return PaginatedResponseDto.of(items, total, query);
  }

  @Get('variants/:variantId/inventory')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({ summary: 'Stock d’une variante (409 si non suivie)' })
  @ApiOkResponse({ type: InventoryRowDto })
  async getForVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('variantId') variantId: string,
  ): Promise<InventoryRowDto> {
    return this.inventoryService.getForVariant(tenant, shopId, variantId);
  }

  @Get('variants/:variantId/inventory/movements')
  @RequirePermissions(PERMISSIONS.INVENTORY_VIEW_MOVEMENTS)
  @ApiOperation({ summary: 'Historique IMMUABLE des mouvements (desc, paginé)' })
  @ApiOkResponse({ type: PaginatedResponseDto<MovementResponseDto> })
  async listMovements(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('variantId') variantId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<MovementResponseDto>> {
    const { items, total } = await this.inventoryService.listMovements(
      tenant,
      shopId,
      variantId,
      query,
    );
    return PaginatedResponseDto.of(
      items.map((movement) => Object.assign(new MovementResponseDto(), movement)),
      total,
      query,
    );
  }

  @Post('variants/:variantId/inventory/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  @ApiOperation({
    summary:
      'Ajuster le stock — RESTOCK/DAMAGE par delta atomique, ADJUSTMENT par quantité cible + expectedVersion (409 si conflit)',
  })
  @ApiOkResponse({ type: AdjustResponseDto })
  async adjust(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('variantId') variantId: string,
    @Body() dto: AdjustInventoryDto,
    @Req() req: Request,
  ): Promise<AdjustResponseDto> {
    const { row, movement } = await this.inventoryService.adjust(
      tenant,
      shopId,
      variantId,
      dto,
      actionContext(req),
    );
    return { inventory: row, movement };
  }
}
