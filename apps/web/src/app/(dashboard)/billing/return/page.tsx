'use client';

import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TERMINAL_TOPUP_STATUSES } from '@/features/wallet/api';
import { clearPendingTopUp, getPendingTopUp } from '@/features/wallet/pending-payment';
import { useTopUp } from '@/features/wallet/use-wallet';
import { useOrganization } from '@/features/organizations/organization-provider';

/**
 * Retour de paiement Genius Pay. Le frontend ne confirme JAMAIS un paiement : il
 * SONDE `GET top-up` (source de vérité = webhook Genius Pay vérifié côté backend)
 * et n'affiche que le statut tranché par le serveur. Le fait de revenir sur cette
 * page n'est JAMAIS une preuve de paiement.
 */
export default function BillingReturnPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;

  const [topUpId, setTopUpId] = useState<string | null>(null);
  useEffect(() => {
    setTopUpId(getPendingTopUp(organizationId));
  }, [organizationId]);

  const query = useTopUp(topUpId);
  const topUp = query.data;
  const isTerminal = topUp ? TERMINAL_TOPUP_STATUSES.includes(topUp.status) : false;

  // Nettoyage du marqueur une fois le statut tranché.
  useEffect(() => {
    if (isTerminal && topUpId) {
      clearPendingTopUp(organizationId);
    }
  }, [isTerminal, topUpId, organizationId]);

  return (
    <div className="mx-auto max-w-lg space-y-4 p-6">
      <Card data-testid="billing-return">
        <CardHeader>
          <CardTitle>Paiement</CardTitle>
          <CardDescription>Confirmation en cours auprès de Genius Pay.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {topUpId === null ? (
            <Empty
              testId="return-none"
              text="Aucun paiement en attente sur cet appareil."
            />
          ) : !topUp ? (
            <Waiting text="Vérification du paiement…" />
          ) : topUp.status === 'PAID' ? (
            <Result
              testId="return-paid"
              icon={<CheckCircle2 aria-hidden className="h-8 w-8 text-primary" />}
              title="Paiement confirmé"
              text={`${topUp.creditsGranted + topUp.bonusCredits} crédits ont été ajoutés à votre solde.`}
            />
          ) : topUp.status === 'REVIEW_REQUIRED' ? (
            <Result
              testId="return-review"
              icon={<Clock aria-hidden className="h-8 w-8 text-amber-600" />}
              title="Paiement en vérification"
              text="Votre paiement nécessite une vérification manuelle. Nos équipes le traitent — votre solde sera crédité une fois validé."
            />
          ) : isTerminal ? (
            <Result
              testId="return-failed"
              icon={<XCircle aria-hidden className="h-8 w-8 text-destructive" />}
              title="Paiement non abouti"
              text="Le paiement n’a pas été confirmé. Aucun crédit n’a été ajouté — vous pouvez réessayer."
            />
          ) : (
            <Waiting text="En attente de la confirmation du paiement…" />
          )}

          <div className="flex justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href="/billing">Retour aux crédits</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="return-waiting"
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
      {text}
    </p>
  );
}

function Result({
  testId,
  icon,
  title,
  text,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      {icon}
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function Empty({ testId, text }: { testId: string; text: string }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid={testId}>
      {text}
    </p>
  );
}
