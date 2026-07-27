'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Package, Search } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';

import { productKeys, productsApi, type Variant } from '../api';
import { STOCK_STATUS_LABELS } from '../labels';
import { formatMinorAmount, formatMinorRange } from '../money';
import { StockStatusBadge } from './stock-status-badge';

function availabilityText(variant: Variant): string {
  if (variant.stockStatus === 'NOT_TRACKED') {
    return 'Disponible';
  }
  return STOCK_STATUS_LABELS[variant.stockStatus];
}

/**
 * Sélecteur produit de l'inbox. Avant toute insertion, la variante est
 * REVALIDÉE en base (produit/variante ACTIVE, même Shop, prix, stock,
 * trackInventory, allowBackorder frais) — jamais le cache du catalogue. Si
 * l'état a changé ou n'est plus vendable, un avertissement s'affiche et
 * l'insertion exige une nouvelle confirmation explicite.
 */
export function ProductPickerDialog({
  onInsert,
  onPickVariant,
  pickLabel,
  onClose,
}: {
  /** Mode texte : reçoit le résumé — l'ENVOI reste l'action explicite du composer. */
  onInsert?: (text: string) => void;
  /** Mode panier : reçoit la variante REVALIDÉE (utilisé par « Ajouter au panier »). */
  onPickVariant?: (variant: Variant, product: { id: string; name: string; currency: string }) => void;
  pickLabel?: string;
  onClose: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const shopId = activeShop?.id ?? '';

  const [search, setSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);

  // Seuls les produits ACTIFS sont proposables au client.
  const listParams = {
    limit: 20,
    status: 'ACTIVE' as const,
    search: search.trim() === '' ? undefined : search.trim(),
  };
  const listQuery = useQuery({
    queryKey: productKeys.list(organizationId, shopId, listParams),
    queryFn: () => productsApi.list(organizationId, shopId, listParams),
    enabled: activeShop !== null,
  });

  // REVALIDATION : état frais de la variante au moment de la sélection.
  const lookupQuery = useQuery({
    queryKey: [...productKeys.all(organizationId, shopId), 'lookup', selectedVariantId],
    queryFn: () => productsApi.lookupVariant(organizationId, shopId, selectedVariantId as string),
    enabled: selectedVariantId !== null,
    gcTime: 0,
    staleTime: 0,
  });

  const selectedProductQuery = useQuery({
    queryKey: productKeys.detail(organizationId, shopId, selectedProductId ?? 'none'),
    queryFn: () => productsApi.get(organizationId, shopId, selectedProductId as string),
    enabled: selectedProductId !== null && selectedVariantId === null,
  });

  const products = listQuery.data?.items ?? [];
  const lookup = lookupQuery.data ?? null;

  // Vendable = produit ACTIVE + variante ACTIVE (revalidés à l'instant).
  const sellable =
    lookup !== null && lookup.product.status === 'ACTIVE' && lookup.variant.status === 'ACTIVE';
  const notSellableReason =
    lookup === null
      ? null
      : lookup.product.status !== 'ACTIVE'
        ? 'Ce produit n’est plus actif.'
        : lookup.variant.status !== 'ACTIVE'
          ? 'Cette variante n’est plus active.'
          : null;

  const selectProduct = (productId: string) => {
    setSelectedProductId(productId);
    setSelectedVariantId(null);
    setWarningAcknowledged(false);
  };

  const insert = () => {
    if (!lookup || !sellable) {
      return;
    }
    if (onPickVariant) {
      onPickVariant(lookup.variant, {
        id: lookup.product.id,
        name: lookup.product.name,
        currency: lookup.product.currency,
      });
      onClose();
      return;
    }
    const variantLabel =
      lookup.variant.isDefault && lookup.variant.optionSelections.length === 0
        ? ''
        : ` — ${lookup.variant.name ?? lookup.variant.optionSelections.map((s) => s.value).join(' / ')}`;
    const text = `${lookup.product.name}${variantLabel} — ${formatMinorAmount(
      lookup.variant.priceMinor,
      lookup.product.currency,
    )} — ${availabilityText(lookup.variant)}`;
    onInsert?.(text);
    onClose();
  };

  const pickerVariants =
    selectedProductQuery.data?.variants.filter((variant) => variant.status === 'ACTIVE') ?? [];

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajouter un produit</DialogTitle>
          <DialogDescription>
            Le résumé est inséré dans le message — rien n’est envoyé sans votre confirmation.
          </DialogDescription>
        </DialogHeader>

        {selectedVariantId === null && selectedProductId === null ? (
          <>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Rechercher un produit actif…"
                className="pl-8"
                aria-label="Rechercher un produit"
                autoFocus
              />
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {listQuery.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : products.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Aucun produit actif ne correspond.
                </p>
              ) : (
                products.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => selectProduct(product.id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-border p-2 text-left transition-colors hover:bg-accent"
                    data-testid="picker-product"
                  >
                    {product.primaryImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires
                      <img
                        src={product.primaryImageUrl}
                        alt=""
                        className="h-10 w-10 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted">
                        <Package aria-hidden className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{product.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatMinorRange(product.minPriceMinor, product.maxPriceMinor, product.currency)}
                        {product.variantCount > 1 ? ` · ${product.variantCount} variantes` : ''}
                      </span>
                    </span>
                    <StockStatusBadge status={product.stockStatus} />
                  </button>
                ))
              )}
            </div>
          </>
        ) : selectedVariantId === null ? (
          // Choix de la variante.
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelectedProductId(null)}
            >
              ← Retour aux produits
            </Button>
            {selectedProductQuery.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : pickerVariants.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Aucune variante active pour ce produit.
              </p>
            ) : (
              pickerVariants.map((variant) => (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() => {
                    setSelectedVariantId(variant.id);
                    setWarningAcknowledged(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-2 text-left transition-colors hover:bg-accent"
                  data-testid="picker-variant"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {variant.name ?? 'Par défaut'}
                    </span>
                    <span className="text-xs text-muted-foreground">{variant.sku}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="whitespace-nowrap text-sm">
                      {formatMinorAmount(
                        variant.priceMinor,
                        selectedProductQuery.data?.currency ?? 'XAF',
                      )}
                    </span>
                    <StockStatusBadge status={variant.stockStatus} />
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          // Prévisualisation de la carte produit, données REVALIDÉES.
          <div className="space-y-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelectedVariantId(null)}
            >
              ← Retour
            </Button>
            {lookupQuery.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : lookupQuery.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{getErrorMessage(lookupQuery.error)}</AlertDescription>
              </Alert>
            ) : lookup ? (
              <>
                {notSellableReason !== null ? (
                  <Alert variant="destructive" data-testid="picker-not-sellable">
                    <AlertTriangle aria-hidden className="h-4 w-4" />
                    <AlertDescription>
                      {notSellableReason} Impossible de l’insérer dans la conversation.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div
                  className="flex gap-3 rounded-xl border border-border p-3"
                  data-testid="product-card-preview"
                >
                  {lookup.product.images[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires
                    <img
                      src={lookup.product.images[0].url}
                      alt=""
                      className="h-20 w-20 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-border bg-muted">
                      <Package aria-hidden className="h-6 w-6 text-muted-foreground" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{lookup.product.name}</p>
                    {lookup.variant.optionSelections.length > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {lookup.variant.optionSelections
                          .map((selection) => `${selection.optionName} : ${selection.value}`)
                          .join(' · ')}
                      </p>
                    ) : null}
                    <p className="mt-1 text-lg font-semibold">
                      {formatMinorAmount(lookup.variant.priceMinor, lookup.product.currency)}
                      {lookup.variant.compareAtPriceMinor !== null ? (
                        <span className="ml-2 text-sm font-normal text-muted-foreground line-through">
                          {formatMinorAmount(
                            lookup.variant.compareAtPriceMinor,
                            lookup.product.currency,
                          )}
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <StockStatusBadge status={lookup.variant.stockStatus} />
                      <Badge variant="outline" className="text-[10px]">
                        données revalidées à l’instant
                      </Badge>
                    </div>
                  </div>
                </div>
                {sellable &&
                (lookup.variant.stockStatus === 'OUT_OF_STOCK' ||
                  lookup.variant.stockStatus === 'LOW_STOCK') &&
                !warningAcknowledged ? (
                  <Alert data-testid="picker-stock-warning">
                    <AlertTriangle aria-hidden className="h-4 w-4" />
                    <AlertDescription className="flex items-center justify-between gap-2">
                      <span>
                        Attention : {STOCK_STATUS_LABELS[lookup.variant.stockStatus].toLowerCase()}.
                        Confirmez avant d’insérer.
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setWarningAcknowledged(true)}
                      >
                        J’ai compris
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Annuler
              </Button>
              <Button
                type="button"
                disabled={
                  !sellable ||
                  lookupQuery.isPending ||
                  ((lookup?.variant.stockStatus === 'OUT_OF_STOCK' ||
                    lookup?.variant.stockStatus === 'LOW_STOCK') &&
                    !warningAcknowledged)
                }
                onClick={insert}
                data-testid="picker-insert"
              >
                {pickLabel ?? 'Insérer dans le message'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
