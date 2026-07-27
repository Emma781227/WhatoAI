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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AddCartItemDto,
  CartMutationDto,
  CartResponseDto,
  CartSummaryResponseDto,
  CartVersionDto,
  ConfirmCheckoutDto,
  RevalidationResponseDto,
  UpdateCartItemDto,
  UpdateCheckoutDto,
} from './dto/cart.dto';
import { CartsService } from './carts.service';
import { CheckoutService } from './checkout.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('carts')
@ApiBearerAuth()
@Controller('organizations/:organizationId/conversations/:conversationId/cart')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class CartsController {
  constructor(
    private readonly cartsService: CartsService,
    private readonly checkoutService: CheckoutService,
  ) {}

  // --------------------------------------------------------------------- cart

  @Get()
  @RequirePermissions(PERMISSIONS.CARTS_READ)
  @ApiOperation({ summary: 'Panier ouvert de la conversation (404 si aucun)' })
  @ApiOkResponse({ type: CartResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(await this.cartsService.getOpenCart(tenant, conversationId));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CARTS_CREATE)
  @ApiOperation({ summary: 'Créer explicitement (idempotent — renvoie l’ouvert existant)' })
  @ApiCreatedResponse({ type: CartResponseDto })
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.createCart(tenant, conversationId, actionContext(req)),
    );
  }

  @Post('items')
  @RequirePermissions(PERMISSIONS.CARTS_UPDATE)
  @ApiOperation({
    summary:
      'Ajouter une variante (crée le panier au premier ajout ; variante déjà présente = incrément)',
  })
  @ApiCreatedResponse({ type: CartResponseDto })
  async addItem(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: AddCartItemDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.addItem(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Patch('items/:cartItemId')
  @RequirePermissions(PERMISSIONS.CARTS_UPDATE)
  @ApiOperation({ summary: 'Modifier la quantité (delta réservé/libéré si checkout en cours)' })
  @ApiOkResponse({ type: CartResponseDto })
  async updateItem(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('cartItemId') cartItemId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.updateItemQuantity(
        tenant,
        conversationId,
        cartItemId,
        dto,
        actionContext(req),
      ),
    );
  }

  @Post('items/:cartItemId/accept-current-price')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CARTS_UPDATE)
  @ApiOperation({
    summary: 'Accepter EXPLICITEMENT le nouveau prix catalogue (jamais silencieux — validé)',
  })
  @ApiOkResponse({ type: CartResponseDto })
  async acceptCurrentPrice(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('cartItemId') cartItemId: string,
    @Body() dto: CartVersionDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.acceptCurrentPrice(
        tenant,
        conversationId,
        cartItemId,
        dto,
        actionContext(req),
      ),
    );
  }

  @Delete('items/:cartItemId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CARTS_UPDATE)
  @ApiOperation({ summary: 'Retirer une ligne (release complet de sa réservation d’abord)' })
  @ApiOkResponse({ type: CartResponseDto })
  async removeItem(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('cartItemId') cartItemId: string,
    @Body() dto: CartVersionDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.removeItem(tenant, conversationId, cartItemId, dto, actionContext(req)),
    );
  }

  @Post('clear')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CARTS_UPDATE)
  @ApiOperation({ summary: 'Vider (release de toutes les réservations avant suppression)' })
  @ApiOkResponse({ type: CartResponseDto })
  async clear(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: CartVersionDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.clear(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Post('revalidate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CARTS_READ)
  @ApiOperation({ summary: 'Revalider toutes les lignes (statuts persistés, jamais de correction silencieuse)' })
  @ApiOkResponse({ type: RevalidationResponseDto })
  async revalidate(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<RevalidationResponseDto> {
    const { cart, lines } = await this.cartsService.revalidate(tenant, conversationId);
    return { cart: CartResponseDto.fromCart(cart), lines };
  }

  @Post('abandon')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CARTS_ABANDON)
  @ApiOperation({ summary: 'Abandonner (terminal — release de toutes les réservations)' })
  @ApiOkResponse({ type: CartResponseDto })
  async abandon(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: CartMutationDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.cartsService.abandon(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Get('summary-text')
  @RequirePermissions(PERMISSIONS.CARTS_READ)
  @ApiOperation({
    summary:
      'Résumé conversationnel généré SERVEUR depuis le panier revalidé — insertion/envoi explicites côté agent',
  })
  @ApiOkResponse({ type: CartSummaryResponseDto })
  async summaryText(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<CartSummaryResponseDto> {
    return this.cartsService.summaryText(tenant, conversationId);
  }

  @Get('reservations')
  @RequirePermissions(PERMISSIONS.STOCK_RESERVATIONS_READ)
  @ApiOperation({ summary: 'Diagnostic des réservations (MANAGER+) — lecture seule' })
  async listReservations(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ) {
    return this.cartsService.listReservations(tenant, conversationId);
  }

  // ----------------------------------------------------------------- checkout

  @Post('checkout/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CHECKOUT_UPDATE)
  @ApiOperation({
    summary:
      'Démarrer le checkout — revalidation + réservation TOUT-OU-RIEN de toutes les lignes (une seule non réservable annule tout)',
  })
  @ApiOkResponse({ type: CartResponseDto })
  async startCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: CartMutationDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.checkoutService.start(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Get('checkout')
  @RequirePermissions(PERMISSIONS.CHECKOUT_READ)
  @ApiOperation({ summary: 'État du checkout (avec panier)' })
  @ApiOkResponse({ type: CartResponseDto })
  async getCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(await this.checkoutService.get(tenant, conversationId));
  }

  @Patch('checkout')
  @RequirePermissions(PERMISSIONS.CHECKOUT_UPDATE)
  @ApiOperation({
    summary:
      'Collecter les informations client (action significative → renouvellement contrôlé des réservations)',
  })
  @ApiOkResponse({ type: CartResponseDto })
  async updateCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: UpdateCheckoutDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.checkoutService.update(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Post('checkout/revalidate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CHECKOUT_READ)
  @ApiOperation({ summary: 'Revalider les lignes pendant le checkout' })
  @ApiOkResponse({ type: RevalidationResponseDto })
  async revalidateCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<RevalidationResponseDto> {
    const { cart, lines } = await this.cartsService.revalidate(tenant, conversationId);
    return { cart: CartResponseDto.fromCart(cart), lines };
  }

  @Post('checkout/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CHECKOUT_CONFIRM)
  @ApiOperation({
    summary:
      'Confirmation ATOMIQUE : versions + revalidation + réservations vivantes + totaux serveur + snapshot immuable',
  })
  @ApiOkResponse({ type: CartResponseDto })
  async confirmCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: ConfirmCheckoutDto,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.checkoutService.confirm(tenant, conversationId, dto, actionContext(req)),
    );
  }

  @Post('checkout/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CHECKOUT_UPDATE)
  @ApiOperation({ summary: 'Annuler le checkout (release des réservations, Cart → ACTIVE)' })
  @ApiOkResponse({ type: CartResponseDto })
  async cancelCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromCart(
      await this.checkoutService.cancel(tenant, conversationId, actionContext(req)),
    );
  }
}
