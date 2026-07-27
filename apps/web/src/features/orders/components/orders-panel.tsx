'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, PackageCheck, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cartKeys } from '@/features/carts/api';
import { useCart } from '@/features/carts/use-cart';
import { useComposerInsert } from '@/features/conversations/composer-insert';
import { useOrganization } from '@/features/organizations/organization-provider';
import { formatMinorAmount } from '@/features/products/money';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

import { orderKeys, ordersApi } from '../api';
import { useConversationOrders } from '../use-conversation-orders';
import {
  FulfillmentStatusBadge,
  OrderStatusBadge,
  PaymentStatusBadge,
} from './order-badges';

/**
 * Onglet « Commandes » du panneau droit de l'inbox (validé §28) :
 * checkout confirmé prêt à convertir + commandes liées à la conversation.
 * Après conversion : le panier passe CONVERTED, l'Order apparaît sans reload
 * (socket + invalidations), le stock est rafraîchi.
 */
export function OrdersPanel({ conversationId }: { conversationId: string }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const { insert } = useComposerInsert();
  const cartQuery = useCart(conversationId);
  const ordersQuery = useConversationOrders(conversationId);

  const cart = cartQuery.data ?? null;
  const confirmedCheckout =
    cart !== null && cart.status === 'CHECKOUT_STARTED' && cart.checkout?.status === 'CONFIRMED'
      ? cart.checkout
      : null;

  const convertMutation = useMutation({
    mutationFn: () =>
      ordersApi.convert(organizationId, conversationId, {
        clientMutationId: crypto.randomUUID(),
        expectedCartVersion: cart?.version,
        expectedCheckoutVersion: confirmedCheckout?.version,
      }),
    onSuccess: (order) => {
      toast.success(`Commande ${order.orderNumber} créée.`);
      // Panier CONVERTED + stock consommé : tout est rafraîchi.
      void queryClient.invalidateQueries({ queryKey: orderKeys.all(organizationId) });
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
      void queryClient.invalidateQueries({ queryKey: ['products', organizationId] });
      void queryClient.invalidateQueries({ queryKey: ['inventory', organizationId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ORDER_CONCURRENCY') {
        toast.error('Le panier a changé entre-temps — données rechargées, réessayez.');
      } else {
        toast.error(getErrorMessage(error));
      }
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
    },
  });

  const summaryMutation = useMutation({
    mutationFn: (orderId: string) => ordersApi.summaryText(organizationId, orderId),
    onSuccess: (summary) => {
      insert(summary.text);
      toast.success('Résumé inséré dans le message — relisez puis envoyez.');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const orders = ordersQuery.data ?? [];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="orders-panel">
      {/* Checkout confirmé → conversion */}
      {confirmedCheckout && can(PERMISSIONS.ORDERS_CREATE) ? (
        <div className="space-y-2 rounded-lg border border-primary bg-primary-subtle p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-primary">
            <PackageCheck aria-hidden className="h-4 w-4" />
            Checkout confirmé — prêt à convertir
          </p>
          <p className="text-xs text-muted-foreground">
            Total {cart ? formatMinorAmount(cart.totalMinor, cart.currency) : ''} — la conversion
            consomme le stock réservé et fige la commande.
          </p>
          <Button
            type="button"
            size="sm"
            className="w-full"
            loading={convertMutation.isPending}
            onClick={() => convertMutation.mutate()}
            data-testid="convert-to-order"
          >
            Créer la commande
          </Button>
        </div>
      ) : null}

      <p className="text-sm font-medium">Commandes de la conversation</p>
      {ordersQuery.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <ReceiptText aria-hidden className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Aucune commande pour cette conversation.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => (
            <div
              key={order.id}
              className="space-y-2 rounded-lg border border-border p-2"
              data-testid="conversation-order"
            >
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/orders/${order.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {order.orderNumber}
                </Link>
                <span className="text-sm font-medium">
                  {formatMinorAmount(order.totalMinor, order.currency)}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                <OrderStatusBadge status={order.status} />
                <PaymentStatusBadge status={order.paymentStatus} />
                <FulfillmentStatusBadge status={order.fulfillmentStatus} />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={summaryMutation.isPending}
                  onClick={() => summaryMutation.mutate(order.id)}
                  data-testid="order-summary-insert"
                >
                  Insérer le résumé
                </Button>
                <Button asChild type="button" variant="ghost" size="sm">
                  <Link href={`/orders/${order.id}`} aria-label={`Détail ${order.orderNumber}`}>
                    <ExternalLink aria-hidden className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
