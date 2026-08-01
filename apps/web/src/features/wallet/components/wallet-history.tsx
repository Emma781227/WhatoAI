'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { useWalletTransactions, useWalletUsage } from '../use-wallet';

const TX_TYPE_LABELS: Record<string, string> = {
  CREDIT_PURCHASE: 'Achat de crédits',
  MANUAL_CREDIT: 'Crédit manuel',
  PROMOTIONAL_CREDIT: 'Crédit promotionnel',
  AI_USAGE_RESERVATION: 'Réservation IA',
  AI_USAGE_DEBIT: 'Consommation IA',
  AI_USAGE_RELEASE: 'Libération réservation',
};

const USAGE_STATUS_LABELS: Record<string, string> = {
  RESERVED: 'Réservé',
  CHARGED: 'Facturé',
  RELEASED: 'Libéré',
  SKIPPED: 'Ignoré',
  FAILED: 'Échec',
  PENDING: 'En attente',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Signe visuel : un CREDIT/RELEASE augmente le disponible, un DEBIT/RESERVE le diminue. */
function signedAmount(direction: string, amount: number): string {
  const positive = direction === 'CREDIT' || direction === 'RELEASE';
  return `${positive ? '+' : '−'}${amount}`;
}

export function WalletTransactionsCard() {
  const { data, isPending } = useWalletTransactions({ page: 1, limit: 20 });

  return (
    <Card data-testid="wallet-transactions">
      <CardHeader>
        <CardTitle>Historique des crédits</CardTitle>
        <CardDescription>Chaque mouvement du solde (achats, consommations IA).</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun mouvement pour l’instant.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Montant</TableHead>
                  <TableHead className="text-right">Solde après</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.items.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(tx.createdAt)}
                    </TableCell>
                    <TableCell>{TX_TYPE_LABELS[tx.type] ?? tx.type}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {signedAmount(tx.direction, tx.amountCredits)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {tx.balanceAfterCredits}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function WalletUsageCard() {
  const { data, isPending } = useWalletUsage({ page: 1, limit: 20 });

  return (
    <Card data-testid="wallet-usage">
      <CardHeader>
        <CardTitle>Consommation IA</CardTitle>
        <CardDescription>Crédits réservés puis facturés par réponse de l’assistant.</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune consommation IA pour l’instant.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="text-right">Outils</TableHead>
                  <TableHead className="text-right">Facturé</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.items.map((usage) => (
                  <TableRow key={usage.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(usage.createdAt)}
                    </TableCell>
                    <TableCell>{USAGE_STATUS_LABELS[usage.status] ?? usage.status}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {usage.successfulToolCalls}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{usage.creditsCharged}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
