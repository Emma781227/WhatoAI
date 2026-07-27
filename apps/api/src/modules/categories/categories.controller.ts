import {
  Body,
  Controller,
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
import {
  CategoryResponseDto,
  CreateCategoryDto,
  ListCategoriesQueryDto,
  UpdateCategoryDto,
} from './dto/category.dto';
import { CategoriesService } from './categories.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('categories')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops/:shopId/categories')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.CATEGORIES_CREATE)
  @ApiOperation({ summary: 'Créer une catégorie (slug généré si absent, nom unique par Shop)' })
  @ApiCreatedResponse({ type: CategoryResponseDto })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: CreateCategoryDto,
    @Req() req: Request,
  ): Promise<CategoryResponseDto> {
    return CategoryResponseDto.fromCategory(
      await this.categoriesService.create(tenant, shopId, dto, actionContext(req)),
    );
  }

  @Get()
  @RequirePermissions(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'Catégories de la Shop (paginées — ARCHIVED exclues par défaut)' })
  @ApiOkResponse({ type: PaginatedResponseDto<CategoryResponseDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Query() query: ListCategoriesQueryDto,
  ): Promise<PaginatedResponseDto<CategoryResponseDto>> {
    const { items, total } = await this.categoriesService.list(tenant, shopId, query);
    return PaginatedResponseDto.of(
      items.map((category) => CategoryResponseDto.fromCategory(category)),
      total,
      query,
    );
  }

  @Get(':categoryId')
  @RequirePermissions(PERMISSIONS.CATEGORIES_READ)
  @ApiOperation({ summary: 'Détail d’une catégorie' })
  @ApiOkResponse({ type: CategoryResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('categoryId') categoryId: string,
  ): Promise<CategoryResponseDto> {
    return CategoryResponseDto.fromCategory(
      await this.categoriesService.getForTenant(tenant, shopId, categoryId),
    );
  }

  @Patch(':categoryId')
  @RequirePermissions(PERMISSIONS.CATEGORIES_UPDATE)
  @ApiOperation({ summary: 'Modifier une catégorie — undefined = inchangé, null = effacement' })
  @ApiOkResponse({ type: CategoryResponseDto })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: Request,
  ): Promise<CategoryResponseDto> {
    return CategoryResponseDto.fromCategory(
      await this.categoriesService.update(tenant, shopId, categoryId, dto, actionContext(req)),
    );
  }

  @Post(':categoryId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CATEGORIES_ARCHIVE)
  @ApiOperation({
    summary: 'Archiver (terminal) — les produits CONSERVENT leur categoryId (historique)',
  })
  @ApiOkResponse({ type: CategoryResponseDto })
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('categoryId') categoryId: string,
    @Req() req: Request,
  ): Promise<CategoryResponseDto> {
    return CategoryResponseDto.fromCategory(
      await this.categoriesService.archive(tenant, shopId, categoryId, actionContext(req)),
    );
  }
}
