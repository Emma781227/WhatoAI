'use client';

import { CreditPackages } from '@/features/wallet/components/credit-packages';
import { WalletBalanceCard } from '@/features/wallet/components/wallet-balance-card';
import {
  WalletTransactionsCard,
  WalletUsageCard,
} from '@/features/wallet/components/wallet-history';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can } from '@/lib/permissions/use-permissions';

/**
 * Page Crédits IA. Solde visible par tous (l'AGENT n'a que le disponible +
 * aiAvailable) ; l'achat de crédits est réservé à `wallet.topUp` (OWNER/ADMIN) et
 * l'historique comptable à `wallet.viewLedger` (MANAGER+) — masquage piloté par
 * les permissions renvoyées par l'API, jamais une matrice recopiée.
 */
export default function BillingPage() {
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Crédits IA</h1>
        <p className="text-sm text-muted-foreground">
          Suivez votre solde, rechargez et consultez la consommation de l’assistant.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <WalletBalanceCard />
        <Can permission={PERMISSIONS.WALLET_TOP_UP}>
          <CreditPackages />
        </Can>
      </div>

      <Can permission={PERMISSIONS.WALLET_VIEW_LEDGER}>
        <div className="grid gap-4 lg:grid-cols-2">
          <WalletTransactionsCard />
          <WalletUsageCard />
        </div>
      </Can>
    </div>
  );
}
