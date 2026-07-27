import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import type { OrderFulfillmentStatus, OrderPaymentStatus, OrderStatus } from '../api';
import {
  FULFILLMENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
} from '../labels';

/**
 * Trois badges DISTINCTS (validé §26) : commande, paiement, livraison — jamais
 * fusionnés en un seul indicateur.
 */

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge
      variant={status === 'CANCELLED' ? 'destructive' : status === 'DELIVERED' ? 'default' : 'secondary'}
      data-testid="order-status-badge"
      data-order-status={status}
    >
      {ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}

export function PaymentStatusBadge({ status }: { status: OrderPaymentStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === 'PAID' && 'border-primary text-primary',
        status === 'FAILED' && 'border-destructive text-destructive',
      )}
      data-testid="payment-status-badge"
      data-payment-status={status}
    >
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function FulfillmentStatusBadge({ status }: { status: OrderFulfillmentStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === 'DELIVERED' && 'border-primary text-primary',
        status === 'CANCELLED' && 'border-destructive text-destructive',
      )}
      data-testid="fulfillment-status-badge"
      data-fulfillment-status={status}
    >
      {FULFILLMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
