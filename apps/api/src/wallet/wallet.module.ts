import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../common/tenant/permissions.guard';
import { TenantGuard } from '../common/tenant/tenant.guard';
import { AuthModule } from '../modules/auth/auth.module';
import { OrganizationsModule } from '../modules/organizations/organizations.module';
import { PaymentProviderFactory } from './payment-provider.factory';
import { TopUpService } from './topup.service';
import { WalletController } from './wallet.controller';
import { WalletQueryService } from './wallet-query.service';
import { WalletService } from './wallet.service';

/**
 * Module Wallet / crédits. Provisioning/lecture + crédit/recharge (groupes 1-2),
 * réservation/finalisation côté worker (3-5), et l'API tenant-scopée (groupe 6 :
 * solde, ledger, packs, recharges). Importe OrganizationsModule pour l'audit et
 * AuthModule pour `JwtAuthGuard`. `RealtimeService` est global (émission du solde).
 */
@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletQueryService,
    TopUpService,
    PaymentProviderFactory,
    TenantGuard,
    PermissionsGuard,
  ],
  exports: [WalletService, TopUpService, PaymentProviderFactory],
})
export class WalletModule {}
