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
import {
  AddOptionValueDto,
  CreateProductDto,
  CreateVariantDto,
  ListProductsQueryDto,
  ReplaceImagesDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product-inputs.dto';
import {
  ProductDetailResponseDto,
  ProductListItemDto,
  toProductListItem,
  VariantResponseDto,
} from './dto/product-responses.dto';
import { ProductsService } from './products.service';
import { VariantsService } from './variants.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

/** costPriceMinor présent uniquement pour les rôles disposant de products.update. */
function includeCost(tenant: TenantContext): { includeCost: boolean } {
  return { includeCost: tenant.permissions.includes(PERMISSIONS.PRODUCTS_UPDATE) };
}

@ApiTags('products')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops/:shopId/products')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly variantsService: VariantsService,
  ) {}

  // ----------------------------------------------------------------- products

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.PRODUCTS_CREATE)
  @ApiOperation({
    summary:
      'Créer un produit COMPLET en une transaction (options, variantes, images, stock initial + mouvements INITIAL)',
  })
  @ApiCreatedResponse({ type: ProductDetailResponseDto })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: CreateProductDto,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.createFull(tenant, shopId, dto, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({
    summary:
      'Produits de la Shop — agrégats, filtre stockStatus et tri prix calculés par PostgreSQL AVANT pagination',
  })
  @ApiOkResponse({ type: PaginatedResponseDto<ProductListItemDto> })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Query() query: ListProductsQueryDto,
  ): Promise<PaginatedResponseDto<ProductListItemDto>> {
    const { rows, total } = await this.productsService.list(tenant, shopId, query);
    const items = rows.map((row) =>
      toProductListItem({
        id: row.product.id,
        name: row.product.name,
        slug: row.product.slug,
        status: row.product.status,
        productType: row.product.productType,
        currency: row.product.currency,
        featured: row.product.featured,
        createdAt: row.product.createdAt,
        updatedAt: row.product.updatedAt,
        category: row.product.category,
        primaryImageUrl:
          row.product.images.find((image) => image.isPrimary)?.url ??
          row.product.images[0]?.url ??
          null,
        aggregates: row.aggregates,
      }),
    );
    return PaginatedResponseDto.of(items, total, query);
  }

  @Get(':productId')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Détail complet (variantes, options, images, stock calculé)' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.getDetail(tenant, shopId, productId),
      includeCost(tenant),
    );
  }

  @Patch(':productId')
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Modifier les champs scalaires — devise immuable, statut via routes dédiées' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.update(tenant, shopId, productId, dto, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_ACTIVATE)
  @ApiOperation({ summary: 'Activer (≥1 variante ACTIVE requise, catégorie non archivée)' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async activate(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.activate(tenant, shopId, productId, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_ACTIVATE)
  @ApiOperation({ summary: 'Désactiver (ACTIVE → INACTIVE)' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async deactivate(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.deactivate(tenant, shopId, productId, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_ARCHIVE)
  @ApiOperation({
    summary: 'Archiver (terminal) — variantes archivées avec, stock/mouvements/images conservés',
  })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.productsService.archive(tenant, shopId, productId, actionContext(req)),
      includeCost(tenant),
    );
  }

  // ------------------------------------------------------------------- images

  @Put(':productId/images')
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Remplacer la galerie (URLs uniquement, une principale max)' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async replaceImages(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body() dto: ReplaceImagesDto,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.variantsService.replaceImages(tenant, shopId, productId, dto, actionContext(req)),
      includeCost(tenant),
    );
  }

  // ----------------------------------------------------------------- variants

  @Post(':productId/variants')
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Ajouter une variante (combinaison unique, stock initial possible)' })
  @ApiCreatedResponse({ type: VariantResponseDto })
  async createVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body() dto: CreateVariantDto,
    @Req() req: Request,
  ): Promise<VariantResponseDto> {
    return VariantResponseDto.fromVariant(
      await this.variantsService.create(tenant, shopId, productId, dto, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Patch(':productId/variants/:variantId')
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Modifier une variante (combinaison immuable — créer + archiver sinon)' })
  @ApiOkResponse({ type: VariantResponseDto })
  async updateVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
    @Req() req: Request,
  ): Promise<VariantResponseDto> {
    return VariantResponseDto.fromVariant(
      await this.variantsService.update(tenant, shopId, productId, variantId, dto, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/variants/:variantId/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Activer une variante' })
  @ApiOkResponse({ type: VariantResponseDto })
  async activateVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Req() req: Request,
  ): Promise<VariantResponseDto> {
    return VariantResponseDto.fromVariant(
      await this.variantsService.activate(tenant, shopId, productId, variantId, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/variants/:variantId/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Désactiver (refusé pour la dernière ACTIVE d’un produit ACTIVE)' })
  @ApiOkResponse({ type: VariantResponseDto })
  async deactivateVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Req() req: Request,
  ): Promise<VariantResponseDto> {
    return VariantResponseDto.fromVariant(
      await this.variantsService.deactivate(tenant, shopId, productId, variantId, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Post(':productId/variants/:variantId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({
    summary: 'Archiver une variante (promotion automatique si c’était la DEFAULT)',
  })
  @ApiOkResponse({ type: VariantResponseDto })
  async archiveVariant(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Req() req: Request,
  ): Promise<VariantResponseDto> {
    return VariantResponseDto.fromVariant(
      await this.variantsService.archive(tenant, shopId, productId, variantId, actionContext(req)),
      includeCost(tenant),
    );
  }

  // ------------------------------------------------------------------ options

  @Post(':productId/options/:optionId/values')
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({ summary: 'Ajouter une valeur à une option existante' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async addOptionValue(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Body() dto: AddOptionValueDto,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.variantsService.addOptionValue(
        tenant,
        shopId,
        productId,
        optionId,
        dto,
        actionContext(req),
      ),
      includeCost(tenant),
    );
  }

  @Delete(':productId/options/:optionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({
    summary: 'Supprimer une option — REFUSÉ tant qu’une variante non archivée l’utilise',
  })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async deleteOption(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.variantsService.deleteOption(tenant, shopId, productId, optionId, actionContext(req)),
      includeCost(tenant),
    );
  }

  @Delete(':productId/options/:optionId/values/:valueId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.PRODUCTS_UPDATE)
  @ApiOperation({
    summary: 'Supprimer une valeur — REFUSÉ tant qu’une variante non archivée l’utilise',
  })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  async deleteOptionValue(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
    @Req() req: Request,
  ): Promise<ProductDetailResponseDto> {
    return ProductDetailResponseDto.fromProduct(
      await this.variantsService.deleteOptionValue(
        tenant,
        shopId,
        productId,
        optionId,
        valueId,
        actionContext(req),
      ),
      includeCost(tenant),
    );
  }
}
