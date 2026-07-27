import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VariantNotFoundError } from '@whauto/shared';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductDetailResponseDto, VariantResponseDto } from './dto/product-responses.dto';
import { PRODUCT_DETAIL_SELECT } from './products.mapper';
import { ApiProperty } from '@nestjs/swagger';

class VariantLookupResponseDto {
  @ApiProperty({ description: 'Produit parent complet (statut inclus).' })
  product!: ProductDetailResponseDto;

  @ApiProperty({ description: 'La variante demandée, avec stock et statut FRAIS.' })
  variant!: VariantResponseDto;
}

/**
 * Revalidation d'une variante — utilisée par le sélecteur produit de l'inbox
 * juste AVANT insertion/envoi : produit et variante relus en base (statuts,
 * prix, stock, trackInventory, allowBackorder actuels), jamais le cache du
 * catalogue. costPriceMinor suit la même règle DTO que partout.
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops/:shopId/variants')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class VariantLookupController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':variantId')
  @RequirePermissions(PERMISSIONS.PRODUCTS_READ)
  @ApiOperation({ summary: 'Revalider une variante (état frais produit + variante + stock)' })
  @ApiOkResponse({ type: VariantLookupResponseDto })
  async lookup(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Param('variantId') variantId: string,
  ): Promise<VariantLookupResponseDto> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, organizationId: tenant.organizationId, shopId },
      select: { id: true, productId: true },
    });
    if (!variant) {
      throw new VariantNotFoundError();
    }
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: variant.productId },
      select: PRODUCT_DETAIL_SELECT,
    });

    const includeCost = tenant.permissions.includes(PERMISSIONS.PRODUCTS_UPDATE);
    const productDto = ProductDetailResponseDto.fromProduct(product, { includeCost });
    const variantDto = productDto.variants.find((candidate) => candidate.id === variantId)!;
    return { product: productDto, variant: variantDto };
  }
}
