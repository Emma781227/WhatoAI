'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Minus,
  PackagePlus,
  Plus,
  ShoppingCart,
  Timer,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useComposerInsert } from '@/features/conversations/composer-insert';
import { useOrganization } from '@/features/organizations/organization-provider';
import { ProductPickerDialog } from '@/features/products/components/product-picker-dialog';
import { formatMinorAmount } from '@/features/products/money';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

import { cartKeys, cartsApi, type Cart, type CartItem } from '../api';
import { useCart } from '../use-cart';
import { CheckoutForm } from './checkout-form';

const AVAILABILITY_LABELS: Record<string, string> = {
  PRICE_CHANGED: 'Prix modifié',
  OUT_OF_STOCK: 'Rupture de stock',
  QUANTITY_REDUCED_REQUIRED: 'Stock insuffisant pour la quantité',
  PRODUCT_UNAVAILABLE: 'Produit indisponible',
  VARIANT_UNAVAILABLE: 'Variante indisponible',
};

/** Compte à rebours d'expiration de réservation — affichage local, autorité serveur. */
function ReservationCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) {
    return (
      <span className="text-xs text-destructive" data-testid="reservation-countdown">
        Réservation expirée
      </span>
    );
  }
  const minutes = Math.floor(remainingMs / 60_000);
  const seconds = Math.floor((remainingMs % 60_000) / 1000);
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="reservation-countdown">
      <Timer aria-hidden className="h-3 w-3" />
      Réservé encore {minutes}:{String(seconds).padStart(2, '0')}
    </span>
  );
}

function CartLine({
  cart,
  item,
  onMutate,
  disabled,
}: {
  cart: Cart;
  item: CartItem;
  onMutate: (fn: () => Promise<Cart>) => void;
  disabled: boolean;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const alert = item.availabilityStatus !== 'VALID' ? AVAILABILITY_LABELS[item.availabilityStatus] : null;

  return (
    <div className="space-y-1 rounded-lg border border-border p-2" data-testid="cart-line">
      <div className="flex items-start gap-2">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires
          <img src={item.imageUrl} alt="" className="h-10 w-10 rounded-md border border-border object-cover" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.productName}</p>
          {item.variantName ? (
            <p className="truncate text-xs text-muted-foreground">{item.variantName}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {formatMinorAmount(item.unitPriceMinor, cart.currency)} / unité
          </p>
        </div>
        <span className="whitespace-nowrap text-sm font-medium">
          {formatMinorAmount(item.lineSubtotalMinor, cart.currency)}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-6 w-6"
            disabled={disabled || item.quantity <= 1}
            aria-label="Diminuer la quantité"
            onClick={() =>
              onMutate(() =>
                cartsApi.updateItem(organizationId, cart.conversationId, item.id, {
                  quantity: item.quantity - 1,
                  expectedVersion: cart.version,
                  clientMutationId: crypto.randomUUID(),
                }),
              )
            }
          >
            <Minus aria-hidden className="h-3 w-3" />
          </Button>
          <span className="w-8 text-center text-sm font-medium" data-testid="line-quantity">
            {item.quantity}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-6 w-6"
            disabled={disabled}
            aria-label="Augmenter la quantité"
            onClick={() =>
              onMutate(() =>
                cartsApi.updateItem(organizationId, cart.conversationId, item.id, {
                  quantity: item.quantity + 1,
                  expectedVersion: cart.version,
                  clientMutationId: crypto.randomUUID(),
                }),
              )
            }
          >
            <Plus aria-hidden className="h-3 w-3" />
          </Button>
        </div>
        {item.reservation ? <ReservationCountdown expiresAt={item.reservation.expiresAt} /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-destructive"
          disabled={disabled}
          aria-label={`Retirer ${item.productName}`}
          onClick={() =>
            onMutate(() =>
              cartsApi.removeItem(organizationId, cart.conversationId, item.id, {
                expectedVersion: cart.version,
              }),
            )
          }
        >
          <Trash2 aria-hidden className="h-3 w-3" />
        </Button>
      </div>

      {alert ? (
        <Alert variant="destructive" className="px-2 py-1.5" data-testid="line-alert">
          <AlertDescription className="flex items-center justify-between gap-2 text-xs">
            <span>
              <AlertTriangle aria-hidden className="mr-1 inline h-3 w-3" />
              {alert}
              {item.availabilityStatus === 'PRICE_CHANGED' && item.currentPriceMinor !== null
                ? ` : ${formatMinorAmount(item.unitPriceMinor, cart.currency)} → ${formatMinorAmount(item.currentPriceMinor, cart.currency)}`
                : ''}
            </span>
            {item.availabilityStatus === 'PRICE_CHANGED' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={disabled}
                data-testid="accept-price"
                onClick={() =>
                  onMutate(() =>
                    cartsApi.acceptCurrentPrice(organizationId, cart.conversationId, item.id, {
                      expectedVersion: cart.version,
                    }),
                  )
                }
              >
                Accepter le nouveau prix
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Panneau Panier (onglet du panneau droit — validé D11). Le serveur reste
 * autoritaire sur prix/totaux/réservations : chaque mutation remplace l'état
 * en cache par la réponse ; l'optimistic se limite au spinner + désactivation.
 */
export function CartPanel({ conversationId }: { conversationId: string }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const { insert } = useComposerInsert();
  const cartQuery = useCart(conversationId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const cart = cartQuery.data ?? null;
  const canUpdate = can(PERMISSIONS.CARTS_UPDATE);
  const isTerminal =
    cart !== null && !['ACTIVE', 'CHECKOUT_STARTED'].includes(cart.status);
  const isConfirmed = cart?.checkout?.status === 'CONFIRMED';
  const frozen = !canUpdate || isTerminal || isConfirmed;

  const mutation = useMutation({
    mutationFn: (fn: () => Promise<Cart>) => fn(),
    onSuccess: (updated) => {
      // Le SERVEUR est la source de vérité : sa réponse remplace le cache.
      queryClient.setQueryData(cartKeys.detail(organizationId, conversationId), updated);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CART_CONCURRENCY') {
        toast.error('Le panier a été modifié entre-temps — données rechargées, réessayez.');
      } else {
        toast.error(getErrorMessage(error));
      }
      // Rollback trivial : refetch de l'état autoritaire.
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
    },
  });
  const runMutation = (fn: () => Promise<Cart>) => mutation.mutate(fn);

  const summaryMutation = useMutation({
    mutationFn: () => cartsApi.summaryText(organizationId, conversationId),
    onSuccess: (summary) => {
      if (summary.warnings.length > 0) {
        toast.warning(
          `Résumé généré avec ${summary.warnings.length} alerte(s) — vérifiez le panier avant l'envoi.`,
        );
      }
      insert(summary.text);
      toast.success('Résumé inséré dans le message — relisez puis envoyez.');
      void queryClient.invalidateQueries({
        queryKey: cartKeys.detail(organizationId, conversationId),
      });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (cartQuery.isPending) {
    return <Skeleton className="m-3 h-40" />;
  }

  if (!cart) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <ShoppingCart aria-hidden className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Aucun panier pour cette conversation.</p>
        {canUpdate ? (
          <Button type="button" onClick={() => setPickerOpen(true)} data-testid="cart-add-product">
            <PackagePlus aria-hidden />
            Ajouter un produit
          </Button>
        ) : null}
        {pickerOpen ? (
          <ProductPickerDialog
            pickLabel="Ajouter au panier"
            onPickVariant={(variant) =>
              runMutation(() =>
                cartsApi.addItem(organizationId, conversationId, {
                  variantId: variant.id,
                  quantity: 1,
                  clientMutationId: crypto.randomUUID(),
                }),
              )
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="cart-panel">
      <div className="flex items-center justify-between">
        <Badge variant={cart.status === 'CHECKOUT_STARTED' ? 'default' : 'secondary'}>
          {cart.status === 'ACTIVE'
            ? 'Panier actif'
            : cart.status === 'CHECKOUT_STARTED'
              ? isConfirmed
                ? 'Commande confirmée'
                : 'Checkout en cours'
              : cart.status === 'CONVERTED'
                ? 'Converti en commande'
                : cart.status}
        </Badge>
        {cart.reservationExpiresAt && !isConfirmed ? (
          <ReservationCountdown expiresAt={cart.reservationExpiresAt} />
        ) : null}
      </div>

      {/* Lignes */}
      <div className="space-y-2">
        {cart.items.map((item) => (
          <CartLine
            key={item.id}
            cart={cart}
            item={item}
            onMutate={runMutation}
            disabled={frozen || mutation.isPending}
          />
        ))}
        {cart.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Panier vide.</p>
        ) : null}
      </div>

      {!frozen ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-testid="cart-add-product">
            <PackagePlus aria-hidden />
            Ajouter
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() =>
              runMutation(async () => (await cartsApi.revalidate(organizationId, conversationId)).cart)
            }
            data-testid="cart-revalidate"
          >
            Revalider
          </Button>
          {cart.items.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={mutation.isPending}
              onClick={() =>
                runMutation(() =>
                  cartsApi.clear(organizationId, conversationId, { expectedVersion: cart.version }),
                )
              }
            >
              Vider
            </Button>
          ) : null}
        </div>
      ) : null}

      <Separator />

      {/* Totaux — TOUJOURS ceux du serveur. */}
      <div className="space-y-1 text-sm" data-testid="cart-totals">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Sous-total</span>
          <span className="font-medium">{formatMinorAmount(cart.subtotalMinor, cart.currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Livraison</span>
          <span>
            {cart.checkout?.fulfillmentType
              ? formatMinorAmount(cart.deliveryFeeMinor, cart.currency)
              : 'à définir'}
          </span>
        </div>
        <div className="flex justify-between text-base font-semibold">
          <span>Total actuel</span>
          <span data-testid="cart-total">{formatMinorAmount(cart.totalMinor, cart.currency)}</span>
        </div>
      </div>

      {cart.items.length > 0 && !isTerminal ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={summaryMutation.isPending}
          onClick={() => summaryMutation.mutate()}
          data-testid="cart-summary"
        >
          Insérer le résumé dans le message
        </Button>
      ) : null}

      <Separator />

      {/* Checkout */}
      {cart.status === 'ACTIVE' && cart.items.length > 0 && canUpdate ? (
        <Button
          type="button"
          disabled={mutation.isPending}
          onClick={() =>
            runMutation(() =>
              cartsApi.startCheckout(organizationId, conversationId, {
                expectedVersion: cart.version,
                clientMutationId: crypto.randomUUID(),
              }),
            )
          }
          data-testid="checkout-start"
        >
          Commencer le checkout (réserver le stock)
        </Button>
      ) : null}

      {cart.status === 'CHECKOUT_STARTED' && cart.checkout ? (
        <CheckoutForm cart={cart} conversationId={conversationId} onMutate={runMutation} />
      ) : null}

      {!canUpdate ? (
        <p className="text-xs text-muted-foreground">Lecture seule (permissions).</p>
      ) : null}

      {pickerOpen ? (
        <ProductPickerDialog
          pickLabel="Ajouter au panier"
          onPickVariant={(variant) =>
            runMutation(() =>
              cartsApi.addItem(organizationId, conversationId, {
                variantId: variant.id,
                quantity: 1,
                expectedVersion: cart.version,
                clientMutationId: crypto.randomUUID(),
              }),
            )
          }
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
