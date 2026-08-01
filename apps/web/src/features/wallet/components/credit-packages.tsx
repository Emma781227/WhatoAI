'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatMinorAmount } from '@/features/products/money';
import { getErrorMessage } from '@/lib/api/api-error';

import type { CreditPackage } from '../api';
import { useCreateTopUp, useCreditPackages, useMockConfirmTopUp } from '../use-wallet';

/**
 * Packs de crédits (OWNER/ADMIN — la carte n'est montée que sous `wallet.topUp`).
 * Phase MOCK : « Acheter » crée la recharge puis confirme un paiement SIMULÉ
 * (jamais présenté comme un vrai encaissement — l'agrégateur réel viendra
 * derrière PaymentProvider). Les montants et crédits sont autoritaires en base.
 */
export function CreditPackages() {
  const packagesQuery = useCreditPackages();
  const createTopUp = useCreateTopUp();
  const mockConfirm = useMockConfirmTopUp();
  const [busyId, setBusyId] = useState<string | null>(null);

  const buy = (pkg: CreditPackage) => {
    setBusyId(pkg.id);
    createTopUp.mutate(pkg.id, {
      onSuccess: (result) => {
        // Le canal de paiement fait autorité (toujours présent dans la session).
        if (result.paymentSession.provider !== 'MOCK') {
          // Fournisseur réel (hors scope actuel) : redirection vers l'agrégateur.
          if (result.paymentSession.checkoutUrl) {
            window.location.href = result.paymentSession.checkoutUrl;
          }
          setBusyId(null);
          return;
        }
        // MOCK : confirmation d'un paiement SIMULÉ.
        mockConfirm.mutate(result.topUp.id, {
          onSuccess: (credited) => {
            toast.success(
              `Paiement simulé : ${result.topUp.creditsGranted + result.topUp.bonusCredits} crédits ajoutés (solde ${credited.balanceAfterCredits}).`,
            );
            setBusyId(null);
          },
          onError: (error) => {
            toast.error(getErrorMessage(error));
            setBusyId(null);
          },
        });
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
        setBusyId(null);
      },
    });
  };

  return (
    <Card data-testid="credit-packages">
      <CardHeader>
        <CardTitle>Acheter des crédits</CardTitle>
        <CardDescription>Paiement simulé (MOCK) pour l’instant — aucun débit réel.</CardDescription>
      </CardHeader>
      <CardContent>
        {packagesQuery.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : (packagesQuery.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun pack disponible pour le moment.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {packagesQuery.data!.items.map((pkg) => (
              <div
                key={pkg.id}
                className="flex flex-col gap-2 rounded-card border border-border p-4"
                data-testid="credit-package"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{pkg.name}</span>
                  {pkg.bonusCredits > 0 ? (
                    <Badge variant="muted" className="bg-primary-subtle text-primary">
                      +{pkg.bonusCredits} bonus
                    </Badge>
                  ) : null}
                </div>
                <span className="flex items-center gap-1.5 text-2xl font-bold tabular-nums">
                  <Sparkles aria-hidden className="h-5 w-5 text-primary" />
                  {pkg.creditsGranted + pkg.bonusCredits}
                  <span className="text-sm font-normal text-muted-foreground">crédits</span>
                </span>
                {pkg.description ? (
                  <p className="text-xs text-muted-foreground">{pkg.description}</p>
                ) : null}
                <Button
                  type="button"
                  className="mt-auto"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => buy(pkg)}
                  data-testid="buy-package"
                >
                  {busyId === pkg.id ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  ) : (
                    `Acheter — ${formatMinorAmount(pkg.priceMinor, pkg.currency)}`
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
