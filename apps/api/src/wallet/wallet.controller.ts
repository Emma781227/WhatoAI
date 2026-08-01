import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentTenant } from '../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../common/tenant/permissions';
import { PermissionsGuard } from '../common/tenant/permissions.guard';
import { RequirePermissions } from '../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../common/tenant/tenant.guard';
import type { TenantContext } from '../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { CreateTopUpDto, WalletPageQueryDto } from './dto/wallet.dto';
import { TopUpService } from './topup.service';
import { WalletQueryService } from './wallet-query.service';

function auditContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

/**
 * API du module Wallet / crédits (groupe 6). Org-scopé (le Wallet est mutualisé
 * par organisation). Chaîne de gardes standard : JwtAuthGuard → TenantGuard →
 * PermissionsGuard. L'AGENT ne lit que le solde disponible (D7) ; le ledger est
 * MANAGER+ ; l'achat de crédits OWNER/ADMIN. Aucun secret paiement n'est exposé.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('organizations/:organizationId/wallet')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class WalletController {
  constructor(
    private readonly query: WalletQueryService,
    private readonly topUps: TopUpService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.WALLET_READ)
  @ApiOperation({ summary: 'Solde du Wallet (AGENT : availableCredits + aiAvailable uniquement)' })
  getWallet(@CurrentTenant() tenant: TenantContext) {
    return this.query.getWallet(tenant);
  }

  @Get('transactions')
  @RequirePermissions(PERMISSIONS.WALLET_VIEW_LEDGER)
  @ApiOperation({ summary: 'Historique du ledger de crédits (mouvements)' })
  listTransactions(@CurrentTenant() tenant: TenantContext, @Query() query: WalletPageQueryDto) {
    return this.query.listTransactions(tenant, query);
  }

  @Get('usage')
  @RequirePermissions(PERMISSIONS.WALLET_VIEW_LEDGER)
  @ApiOperation({ summary: 'Consommation IA par run (crédits réservés/facturés)' })
  listUsage(@CurrentTenant() tenant: TenantContext, @Query() query: WalletPageQueryDto) {
    return this.query.listUsageEvents(tenant, query);
  }

  @Get('packages')
  @RequirePermissions(PERMISSIONS.WALLET_TOP_UP)
  @ApiOperation({ summary: 'Packs de crédits disponibles (montants autoritaires)' })
  listPackages() {
    return this.query.listPackages();
  }

  @Post('top-ups')
  @RequirePermissions(PERMISSIONS.WALLET_TOP_UP)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crée une recharge (intention de paiement) — retourne la session' })
  createTopUp(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateTopUpDto,
    @Req() req: Request,
  ) {
    return this.topUps.createTopUp(
      tenant.organizationId,
      tenant.userId,
      dto.creditPackageId,
      auditContext(req),
    );
  }

  @Get('top-ups')
  @RequirePermissions(PERMISSIONS.WALLET_TOP_UP)
  @ApiOperation({ summary: 'Historique des recharges de l’organisation' })
  listTopUps(@CurrentTenant() tenant: TenantContext, @Query() query: WalletPageQueryDto) {
    return this.query.listTopUps(tenant, query);
  }

  @Get('top-ups/:topUpId')
  @RequirePermissions(PERMISSIONS.WALLET_TOP_UP)
  @ApiOperation({ summary: 'Détail d’une recharge (tenant-scopé)' })
  getTopUp(@CurrentTenant() tenant: TenantContext, @Param('topUpId') topUpId: string) {
    return this.query.getTopUp(tenant, topUpId);
  }

  @Post('top-ups/:topUpId/mock-confirm')
  @RequirePermissions(PERMISSIONS.WALLET_TOP_UP)
  @ApiOperation({ summary: 'Confirme une recharge MOCK (dev/test uniquement) → crédite le Wallet' })
  mockConfirm(
    @CurrentTenant() tenant: TenantContext,
    @Param('topUpId') topUpId: string,
    @Req() req: Request,
  ) {
    return this.topUps.mockConfirm(tenant.organizationId, topUpId, auditContext(req));
  }
}
