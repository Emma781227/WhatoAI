'use client';

import { AlertTriangle, Coins, Wallet } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { useWallet } from '../use-wallet';

/**
 * Carte de solde. L'AGENT ne voit que `availableCredits` + `aiAvailable` (le
 * détail comptable est ABSENT de la réponse, D7 — pas un masquage d'affichage).
 * `aiAvailable=false` déclenche un rappel de recharge.
 */
export function WalletBalanceCard() {
  const { data, isPending, isError } = useWallet();

  return (
    <Card data-testid="wallet-balance-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet aria-hidden className="h-5 w-5 text-primary" />
          Crédits IA
        </CardTitle>
        <CardDescription>
          Chaque réponse de l’assistant consomme des crédits. Rechargez pour garder l’IA active.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <Skeleton className="h-16 w-40" />
        ) : isError ? (
          <p className="text-sm text-destructive">Solde indisponible pour le moment.</p>
        ) : data ? (
          <>
            <div className="flex items-end gap-3">
              <span
                className="flex items-center gap-2 text-4xl font-bold tabular-nums"
                data-testid="wallet-available"
              >
                <Coins aria-hidden className="h-7 w-7 text-primary" />
                {data.availableCredits}
              </span>
              <span className="pb-1 text-sm text-muted-foreground">crédits disponibles</span>
            </div>

            {data.aiAvailable ? (
              <Badge variant="muted" className="bg-primary-subtle text-primary" data-testid="ai-available">
                Assistant IA actif
              </Badge>
            ) : (
              <p
                className="flex items-center gap-2 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                data-testid="ai-unavailable"
              >
                <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
                Crédits insuffisants — l’assistant IA ne répondra plus tant que le solde n’est pas
                rechargé.
              </p>
            )}

            {data.balanceCredits !== undefined ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="wallet-ledger-detail">
                <dt className="text-muted-foreground">Solde total</dt>
                <dd className="text-right tabular-nums">{data.balanceCredits}</dd>
                <dt className="text-muted-foreground">Réservés (en cours)</dt>
                <dd className="text-right tabular-nums">{data.reservedCredits}</dd>
                <dt className="text-muted-foreground">Statut</dt>
                <dd className="text-right">{data.status}</dd>
              </dl>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
