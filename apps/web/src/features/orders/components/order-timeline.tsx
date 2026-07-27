'use client';

import { useQuery } from '@tanstack/react-query';

import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/features/organizations/organization-provider';

import { orderKeys, ordersApi } from '../api';
import {
  FULFILLMENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
} from '../labels';

/** Timeline chronologique depuis OrderStatusHistory (immuable, serveur). */
export function OrderTimeline({ orderId }: { orderId: string }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const historyQuery = useQuery({
    queryKey: orderKeys.history(organizationId, orderId),
    queryFn: () => ordersApi.history(organizationId, orderId),
  });

  if (historyQuery.isPending) {
    return <Skeleton className="h-24 w-full" />;
  }
  const entries = historyQuery.data ?? [];
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun historique.</p>;
  }

  return (
    <ol className="space-y-3 border-l border-border pl-4">
      {entries.map((entry) => {
        const parts: string[] = [];
        if (entry.previousStatus !== entry.newStatus) {
          parts.push(
            entry.previousStatus
              ? `${ORDER_STATUS_LABELS[entry.previousStatus]} → ${ORDER_STATUS_LABELS[entry.newStatus]}`
              : `Commande ${ORDER_STATUS_LABELS[entry.newStatus].toLowerCase()}`,
          );
        }
        if (entry.previousPaymentStatus !== entry.newPaymentStatus) {
          parts.push(`Paiement : ${PAYMENT_STATUS_LABELS[entry.newPaymentStatus]}`);
        }
        if (entry.previousFulfillmentStatus !== entry.newFulfillmentStatus) {
          parts.push(`Livraison : ${FULFILLMENT_STATUS_LABELS[entry.newFulfillmentStatus]}`);
        }
        return (
          <li key={entry.id} className="relative" data-testid="timeline-entry">
            <span
              aria-hidden
              className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary"
            />
            <p className="text-sm font-medium">{parts.join(' · ') || 'Mise à jour'}</p>
            {entry.reason ? (
              <p className="text-xs text-muted-foreground">Raison : {entry.reason}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {entry.actorName ?? 'Système'} · {new Date(entry.createdAt).toLocaleString('fr-FR')}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
