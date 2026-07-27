'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ErrorState } from '@/components/feedback/error-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { orderKeys, ordersApi, type Order } from '@/features/orders/api';
import {
  FulfillmentStatusBadge,
  OrderStatusBadge,
  PaymentStatusBadge,
} from '@/features/orders/components/order-badges';
import { OrderTimeline } from '@/features/orders/components/order-timeline';
import {
  FULFILLMENT_TYPE_LABELS,
  isCancellable,
  nextStatuses,
  ORDER_STATUS_LABELS,
  PAYMENT_PREFERENCE_LABELS,
} from '@/features/orders/labels';
import { useOrganization } from '@/features/organizations/organization-provider';
import { formatMinorAmount } from '@/features/products/money';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

function CancelDialog({
  order,
  onClose,
}: {
  order: Order;
  onClose: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const cancelMutation = useMutation({
    mutationFn: () =>
      ordersApi.cancel(organizationId, order.id, {
        expectedVersion: order.version,
        reason: reason.trim() === '' ? undefined : reason.trim(),
        clientMutationId: crypto.randomUUID(),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(orderKeys.detail(organizationId, order.id), updated);
      void queryClient.invalidateQueries({ queryKey: orderKeys.all(organizationId) });
      toast.success('Commande annulée — stock restitué.');
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ORDER_CONCURRENCY') {
        toast.error('La commande a été modifiée entre-temps — données rechargées, réessayez.');
      } else {
        toast.error(getErrorMessage(error));
      }
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(organizationId, order.id) });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Annuler la commande {order.orderNumber} ?</DialogTitle>
          <DialogDescription>
            Le stock consommé sera restitué. Cette action est définitive — la commande restera
            visible avec le statut Annulée.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="cancel-reason">Raison (optionnelle)</Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={2}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Garder la commande
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={cancelMutation.isPending}
            onClick={() => cancelMutation.mutate()}
            data-testid="confirm-cancel-order"
          >
            Annuler la commande
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function OrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const router = useRouter();
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');

  const orderQuery = useQuery({
    queryKey: orderKeys.detail(organizationId, orderId),
    queryFn: () => ordersApi.get(organizationId, orderId),
  });
  const notesQuery = useQuery({
    queryKey: orderKeys.notes(organizationId, orderId),
    queryFn: () => ordersApi.notes(organizationId, orderId),
    enabled: can(PERMISSIONS.ORDERS_ADD_NOTE),
  });

  const statusMutation = useMutation({
    mutationFn: (input: { status: Order['status']; expectedVersion: number }) =>
      ordersApi.changeStatus(organizationId, orderId, {
        ...input,
        clientMutationId: crypto.randomUUID(),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(orderKeys.detail(organizationId, orderId), updated);
      void queryClient.invalidateQueries({ queryKey: orderKeys.history(organizationId, orderId) });
      toast.success('Statut mis à jour.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: orderKeys.detail(organizationId, orderId) });
    },
  });

  const noteMutation = useMutation({
    mutationFn: () =>
      ordersApi.addNote(organizationId, orderId, {
        content: noteDraft.trim(),
        clientMutationId: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setNoteDraft('');
      void queryClient.invalidateQueries({ queryKey: orderKeys.notes(organizationId, orderId) });
      toast.success('Note ajoutée.');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (orderQuery.isPending) {
    return <Skeleton className="m-6 h-72" />;
  }
  if (orderQuery.isError) {
    return (
      <div className="p-6">
        <ErrorState error={orderQuery.error} onRetry={() => void orderQuery.refetch()} />
      </div>
    );
  }
  const order = orderQuery.data;
  const paymentToCollect =
    order.paymentStatus === 'UNPAID' &&
    (order.paymentPreference === 'CASH_ON_DELIVERY' || order.paymentPreference === 'PAY_IN_STORE');

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/orders')}>
            <ArrowLeft aria-hidden />
            Commandes
          </Button>
          <h1 className="text-xl font-semibold" data-testid="order-number">
            {order.orderNumber}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            <PaymentStatusBadge status={order.paymentStatus} />
            <FulfillmentStatusBadge status={order.fulfillmentStatus} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(PERMISSIONS.ORDERS_UPDATE_STATUS)
            ? nextStatuses(order.status, order.fulfillmentType).map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="sm"
                  disabled={statusMutation.isPending}
                  onClick={() =>
                    statusMutation.mutate({ status, expectedVersion: order.version })
                  }
                  data-testid={`status-action-${status}`}
                >
                  Passer à « {ORDER_STATUS_LABELS[status]} »
                </Button>
              ))
            : null}
          {can(PERMISSIONS.ORDERS_CANCEL) && isCancellable(order.status) ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setCancelOpen(true)}
              data-testid="cancel-order"
            >
              Annuler
            </Button>
          ) : null}
        </div>
      </div>

      {paymentToCollect && order.status !== 'CANCELLED' ? (
        <Alert data-testid="payment-to-collect">
          <AlertDescription className="flex items-center gap-2">
            <AlertTriangle aria-hidden className="h-4 w-4" />
            Paiement à encaisser ({PAYMENT_PREFERENCE_LABELS[order.paymentPreference]}) — aucun
            passage automatique à « Payé ».
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Articles — SNAPSHOTS historiques, jamais le catalogue courant. */}
          <section className="rounded-card border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Articles (snapshot à la commande)</h2>
            <div className="space-y-2">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-3 rounded-lg border border-border p-2"
                  data-testid="order-item"
                >
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="h-10 w-10 rounded-md border border-border object-cover"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {item.productName}
                      {item.variantName ? ` — ${item.variantName}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      SKU {item.sku} · {formatMinorAmount(item.unitPriceMinor, item.currency)} ×{' '}
                      {item.quantity}
                    </p>
                    {item.backorderedQuantity > 0 ? (
                      <p className="text-xs text-destructive">
                        {item.backorderedQuantity} en attente de réapprovisionnement
                      </p>
                    ) : null}
                  </div>
                  <span className="whitespace-nowrap text-sm font-medium">
                    {formatMinorAmount(item.lineSubtotalMinor, item.currency)}
                  </span>
                </div>
              ))}
            </div>
            <Separator className="my-3" />
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sous-total</span>
                <span>{formatMinorAmount(order.subtotalMinor, order.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Livraison</span>
                <span>{formatMinorAmount(order.deliveryFeeMinor, order.currency)}</span>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <span>Total</span>
                <span data-testid="order-total">
                  {formatMinorAmount(order.totalMinor, order.currency)}
                </span>
              </div>
            </div>
          </section>

          {/* Timeline */}
          {can(PERMISSIONS.ORDERS_VIEW_HISTORY) ? (
            <section className="rounded-card border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Historique</h2>
              <OrderTimeline orderId={orderId} />
            </section>
          ) : null}

          {/* Notes internes */}
          {can(PERMISSIONS.ORDERS_ADD_NOTE) ? (
            <section className="rounded-card border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Notes internes</h2>
              <div className="space-y-2">
                {(notesQuery.data ?? []).map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg border border-border bg-accent/40 p-2 text-sm"
                    data-testid="order-note"
                  >
                    <p>{note.content}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {note.authorName ?? 'Système'} ·{' '}
                      {new Date(note.createdAt).toLocaleString('fr-FR')}
                    </p>
                  </div>
                ))}
                {notesQuery.data && notesQuery.data.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune note.</p>
                ) : null}
              </div>
              <div className="mt-3 flex gap-2">
                <Textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="Note interne (jamais envoyée au client)…"
                  maxLength={2000}
                  rows={2}
                  aria-label="Nouvelle note interne"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={noteDraft.trim() === '' || noteMutation.isPending}
                  onClick={() => noteMutation.mutate()}
                  data-testid="add-order-note"
                >
                  Ajouter
                </Button>
              </div>
            </section>
          ) : null}
        </div>

        <div className="space-y-4">
          {/* Client + adresse (snapshot) */}
          <section className="rounded-card border border-border bg-card p-4 text-sm">
            <h2 className="mb-2 text-sm font-semibold">Client</h2>
            <p className="font-medium">{order.customerName}</p>
            <p className="text-muted-foreground">{order.customerPhone}</p>
            {order.customerEmail ? (
              <p className="text-muted-foreground">{order.customerEmail}</p>
            ) : null}
            <Separator className="my-3" />
            <h3 className="mb-1 font-semibold">
              {FULFILLMENT_TYPE_LABELS[order.fulfillmentType]}
            </h3>
            {order.fulfillmentType === 'DELIVERY' ? (
              <div className="text-muted-foreground">
                {order.addressLine1 ? <p>{order.addressLine1}</p> : null}
                {order.landmark ? <p>Repère : {order.landmark}</p> : null}
                <p>{[order.city, order.countryCode].filter(Boolean).join(', ')}</p>
                {order.deliveryInstructions ? <p>{order.deliveryInstructions}</p> : null}
              </div>
            ) : (
              <p className="text-muted-foreground">Retrait en boutique {order.shop.name}</p>
            )}
            <Separator className="my-3" />
            <p>
              <span className="text-muted-foreground">Paiement : </span>
              {PAYMENT_PREFERENCE_LABELS[order.paymentPreference]}
            </p>
            {order.cancellationReason ? (
              <>
                <Separator className="my-3" />
                <p className="text-destructive">Annulation : {order.cancellationReason}</p>
              </>
            ) : null}
          </section>

          <section className="rounded-card border border-border bg-card p-4 text-sm">
            <h2 className="mb-2 text-sm font-semibold">Conversation liée</h2>
            <Button asChild type="button" variant="outline" size="sm">
              <Link href={`/conversations?c=${order.conversationId}`}>
                <span className="flex items-center gap-2">
                  <MessageSquareText aria-hidden className="h-4 w-4" />
                  Ouvrir la conversation
                </span>
              </Link>
            </Button>
          </section>
        </div>
      </div>

      {cancelOpen ? <CancelDialog order={order} onClose={() => setCancelOpen(false)} /> : null}
    </div>
  );
}
