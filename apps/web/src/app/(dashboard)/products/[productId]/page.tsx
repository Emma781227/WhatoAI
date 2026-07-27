'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Package, Pencil, PowerOff } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useOrganization } from '@/features/organizations/organization-provider';
import { productKeys, productsApi } from '@/features/products/api';
import { StockStatusBadge } from '@/features/products/components/stock-status-badge';
import { PRODUCT_STATUS_LABELS, PRODUCT_TYPE_LABELS, VARIANT_STATUS_LABELS } from '@/features/products/labels';
import { formatMinorAmount } from '@/features/products/money';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

export default function ProductDetailPage() {
  const params = useParams<{ productId: string }>();
  const productId = params.productId;
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const shopId = activeShop?.id ?? '';

  const query = useQuery({
    queryKey: productKeys.detail(organizationId, shopId, productId),
    queryFn: () => productsApi.get(organizationId, shopId, productId),
    enabled: activeShop !== null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: productKeys.all(organizationId, shopId) });
  };

  const actionMutation = useMutation({
    mutationFn: (action: 'activate' | 'deactivate' | 'archive') =>
      productsApi[action](organizationId, shopId, productId),
    onSuccess: (_, action) => {
      toast.success(
        action === 'activate'
          ? 'Produit activé.'
          : action === 'deactivate'
            ? 'Produit désactivé.'
            : 'Produit archivé (variantes incluses).',
      );
      invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const variantActionMutation = useMutation({
    mutationFn: ({
      variantId,
      action,
    }: {
      variantId: string;
      action: 'activate' | 'deactivate' | 'archive';
    }) => productsApi.variantAction(organizationId, shopId, productId, variantId, action),
    onSuccess: invalidate,
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (query.isPending) {
    return <Skeleton className="m-6 h-64 w-full" />;
  }
  if (query.isError) {
    return (
      <div className="p-6">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const product = query.data;
  const isArchived = product.status === 'ARCHIVED';
  const visibleVariants = product.variants.filter((variant) => variant.status !== 'ARCHIVED');
  const showCost = can(PERMISSIONS.PRODUCTS_UPDATE);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/products" className="hover:text-foreground hover:underline">
              Produits
            </Link>
            <span>/</span>
            <span className="text-foreground">{product.name}</span>
          </div>
          <h1 className="flex items-center gap-2 font-heading text-xl font-bold">
            {product.name}
            <Badge variant={product.status === 'ACTIVE' ? 'secondary' : 'outline'}>
              {PRODUCT_STATUS_LABELS[product.status]}
            </Badge>
            <StockStatusBadge status={product.stockStatus} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {PRODUCT_TYPE_LABELS[product.productType]} · {product.slug} ·{' '}
            {product.category ? (
              <>
                {product.category.name}
                {product.category.status === 'ARCHIVED' ? ' (catégorie archivée)' : ''}
              </>
            ) : (
              'sans catégorie'
            )}
          </p>
        </div>
        {!isArchived ? (
          <div className="flex flex-wrap gap-2">
            <Can permission={PERMISSIONS.PRODUCTS_UPDATE}>
              <Button asChild variant="outline">
                <Link href={`/products/${product.id}/edit`}>
                  <Pencil aria-hidden />
                  Modifier
                </Link>
              </Button>
            </Can>
            <Can permission={PERMISSIONS.PRODUCTS_ACTIVATE}>
              {product.status === 'ACTIVE' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('deactivate')}
                >
                  <PowerOff aria-hidden />
                  Désactiver
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={actionMutation.isPending}
                  onClick={() => actionMutation.mutate('activate')}
                >
                  <CheckCircle2 aria-hidden />
                  Activer
                </Button>
              )}
            </Can>
            <Can permission={PERMISSIONS.PRODUCTS_ARCHIVE}>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline" className="text-destructive">
                    <Archive aria-hidden />
                    Archiver
                  </Button>
                }
                title={`Archiver « ${product.name} » ?`}
                description="Action définitive : le produit et toutes ses variantes deviennent invendables. Stock, mouvements et images sont conservés."
                confirmLabel="Archiver"
                destructive
                onConfirm={() => actionMutation.mutate('archive')}
              />
            </Can>
          </div>
        ) : null}
      </div>

      {product.images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {product.images.map((image) => (
            // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires
            <img
              key={image.id}
              src={image.url}
              alt={image.altText ?? ''}
              className={`h-24 w-24 rounded-lg border object-cover ${image.isPrimary ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
            />
          ))}
        </div>
      ) : null}

      {product.shortDescription ? <p className="text-sm">{product.shortDescription}</p> : null}
      {product.description ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{product.description}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package aria-hidden className="h-4 w-4" />
            {visibleVariants.length > 1 || product.options.length > 0
              ? `Variantes (${visibleVariants.length})`
              : 'Offre'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variante</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Prix</TableHead>
                {showCost ? <TableHead>Coût</TableHead> : null}
                <TableHead>Stock dispo</TableHead>
                <TableHead>Disponibilité</TableHead>
                <TableHead>Statut</TableHead>
                {!isArchived && can(PERMISSIONS.PRODUCTS_UPDATE) ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleVariants.map((variant) => (
                <TableRow key={variant.id} data-testid="variant-row">
                  <TableCell className="font-medium">
                    {variant.name ?? 'Par défaut'}
                    {variant.isDefault ? (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        défaut
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatMinorAmount(variant.priceMinor, product.currency)}
                    {variant.compareAtPriceMinor !== null ? (
                      <span className="ml-1 text-xs text-muted-foreground line-through">
                        {formatMinorAmount(variant.compareAtPriceMinor, product.currency)}
                      </span>
                    ) : null}
                  </TableCell>
                  {showCost ? (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {variant.costPriceMinor != null
                        ? formatMinorAmount(variant.costPriceMinor, product.currency)
                        : '—'}
                    </TableCell>
                  ) : null}
                  <TableCell>{variant.inventory?.quantityAvailable ?? '—'}</TableCell>
                  <TableCell>
                    <StockStatusBadge status={variant.stockStatus} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={variant.status === 'ACTIVE' ? 'secondary' : 'outline'}>
                      {VARIANT_STATUS_LABELS[variant.status]}
                    </Badge>
                  </TableCell>
                  {!isArchived && can(PERMISSIONS.PRODUCTS_UPDATE) ? (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {variant.status === 'ACTIVE' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            disabled={variantActionMutation.isPending}
                            onClick={() =>
                              variantActionMutation.mutate({
                                variantId: variant.id,
                                action: 'deactivate',
                              })
                            }
                          >
                            Désactiver
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            disabled={variantActionMutation.isPending}
                            onClick={() =>
                              variantActionMutation.mutate({
                                variantId: variant.id,
                                action: 'activate',
                              })
                            }
                          >
                            Activer
                          </Button>
                        )}
                        <ConfirmDialog
                          trigger={
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-xs text-destructive"
                            >
                              Archiver
                            </Button>
                          }
                          title={`Archiver la variante « ${variant.name ?? variant.sku} » ?`}
                          description="Action définitive : cette variante ne sera plus vendable. Son stock et son historique sont conservés."
                          confirmLabel="Archiver"
                          destructive
                          onConfirm={() =>
                            variantActionMutation.mutate({ variantId: variant.id, action: 'archive' })
                          }
                        />
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
