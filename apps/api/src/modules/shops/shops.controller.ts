import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaginatedResponseDto } from '../organizations/dto/pagination.dto';
import { CreateShopDto } from './dto/create-shop.dto';
import { ListShopsQueryDto } from './dto/list-shops.query.dto';
import { OpeningHoursResponseDto, ReplaceOpeningHoursDto } from './dto/opening-hours.dto';
import { ShopResponseDto } from './dto/shop-responses.dto';
import { UpdateShopDto } from './dto/update-shop.dto';
import { OpeningHoursService } from './opening-hours.service';
import { ShopsService } from './shops.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('shops')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ShopsController {
  constructor(
    private readonly shopsService: ShopsService,
    private readonly openingHoursService: OpeningHoursService,
  ) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.SHOPS_CREATE)
  @ApiOperation({ summary: 'Créer une boutique (la première devient automatiquement principale)' })
  @ApiCreatedResponse({ type: ShopResponseDto })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateShopDto,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(await this.shopsService.create(tenant, dto, actionContext(req)));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.SHOPS_READ)
  @ApiOperation({
    summary: 'Boutiques de l’organisation (paginées, recherche, filtres — ARCHIVED exclues par défaut)',
  })
  @ApiOkResponse({ type: PaginatedResponseDto<ShopResponseDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListShopsQueryDto,
  ): Promise<PaginatedResponseDto<ShopResponseDto>> {
    const { items, total } = await this.shopsService.list(tenant, query);
    return PaginatedResponseDto.of(
      items.map((shop) => ShopResponseDto.fromShop(shop)),
      total,
      query,
    );
  }

  @Get(':shopId')
  @RequirePermissions(PERMISSIONS.SHOPS_READ)
  @ApiOperation({ summary: 'Détail d’une boutique (archivée : lecture seule)' })
  @ApiOkResponse({ type: ShopResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(await this.shopsService.getForTenant(tenant, shopId));
  }

  @Patch(':shopId')
  @RequirePermissions(PERMISSIONS.SHOPS_UPDATE)
  @ApiOperation({
    summary: 'Modifier une boutique — undefined = inchangé, null = effacement d’un champ optionnel',
  })
  @ApiOkResponse({ type: ShopResponseDto })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: UpdateShopDto,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(
      await this.shopsService.update(tenant, shopId, dto, actionContext(req)),
    );
  }

  @Post(':shopId/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHOPS_ACTIVATE)
  @ApiOperation({ summary: 'Activer (DRAFT/INACTIVE → ACTIVE, champs minimums requis)' })
  @ApiOkResponse({ type: ShopResponseDto })
  async activate(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(
      await this.shopsService.activate(tenant, shopId, actionContext(req)),
    );
  }

  @Post(':shopId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHOPS_ACTIVATE)
  @ApiOperation({ summary: 'Désactiver (ACTIVE → INACTIVE)' })
  @ApiOkResponse({ type: ShopResponseDto })
  async deactivate(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(
      await this.shopsService.deactivate(tenant, shopId, actionContext(req)),
    );
  }

  @Post(':shopId/set-primary')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHOPS_ACTIVATE)
  @ApiOperation({ summary: 'Définir comme boutique principale (idempotent)' })
  @ApiOkResponse({ type: ShopResponseDto })
  async setPrimary(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(
      await this.shopsService.setPrimary(tenant, shopId, actionContext(req)),
    );
  }

  @Post(':shopId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.SHOPS_ARCHIVE)
  @ApiOperation({
    summary: 'Archiver (terminal) — promotion automatique d’une nouvelle principale si besoin',
  })
  @ApiOkResponse({ type: ShopResponseDto })
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<ShopResponseDto> {
    return ShopResponseDto.fromShop(
      await this.shopsService.archive(tenant, shopId, actionContext(req)),
    );
  }

  @Get(':shopId/opening-hours')
  @RequirePermissions(PERMISSIONS.SHOPS_READ)
  @ApiOperation({ summary: 'Horaires d’ouverture (7 jours, jour sans plage = fermé)' })
  @ApiOkResponse({ type: OpeningHoursResponseDto })
  async getOpeningHours(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
  ): Promise<OpeningHoursResponseDto> {
    const { timezone, rows } = await this.openingHoursService.get(tenant, shopId);
    return OpeningHoursResponseDto.fromRows(timezone, rows);
  }

  @Put(':shopId/opening-hours')
  @RequirePermissions(PERMISSIONS.SHOPS_MANAGE_SETTINGS)
  @ApiOperation({ summary: 'Remplacer complètement les horaires (transactionnel)' })
  @ApiOkResponse({ type: OpeningHoursResponseDto })
  async replaceOpeningHours(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: ReplaceOpeningHoursDto,
    @Req() req: Request,
  ): Promise<OpeningHoursResponseDto> {
    const { timezone, rows } = await this.openingHoursService.replace(
      tenant,
      shopId,
      dto.days,
      actionContext(req),
    );
    return OpeningHoursResponseDto.fromRows(timezone, rows);
  }
}
