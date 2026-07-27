'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderTree, Package, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { categoriesApi, categoryKeys } from '@/features/categories/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { productKeys, productsApi, type ListProductsParams, type ProductStatus, type StockStatus } from '@/features/products/api';
import { StockStatusBadge } from '@/features/products/components/stock-status-badge';
import { PRODUCT_STATUS_LABELS, STOCK_STATUS_LABELS } from '@/features/products/labels';
import { formatMinorRange } from '@/features/products/money';
import { useActiveShop } from '@/features/shops/shop-provider';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can } from '@/lib/permissions/use-permissions';

const PAGE_SIZE = 20;

export default function ProductsPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ProductStatus>('ALL');
  const [stockFilter, setStockFilter] = useState<'ALL' | StockStatus>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [page, setPage] = useState(1);

  const shopId = activeShop?.id ?? '';
  const params: ListProductsParams = {
    page,
    limit: PAGE_SIZE,
    search: search.trim() === '' ? undefined : search.trim(),
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    stockStatus: stockFilter === 'ALL' ? undefined : stockFilter,
    categoryId: categoryFilter === 'ALL' ? undefined : categoryFilter,
  };

  const query = useQuery({
    queryKey: productKeys.list(organizationId, shopId, params),
    queryFn: () => productsApi.list(organizationId, shopId, params),
    enabled: activeShop !== null,
  });

  const categoriesQuery = useQuery({
    queryKey: categoryKeys.list(organizationId, shopId, { limit: 100 }),
    queryFn: () => categoriesApi.list(organizationId, shopId, { limit: 100 }),
    enabled: activeShop !== null,
  });

  if (!activeShop) {
    return (
      <EmptyState
        title="Aucune boutique"
        description="Créez une boutique pour construire son catalogue."
      />
    );
  }

  const products = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = () => setPage(1);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold">Produits</h1>
          <p className="text-sm text-muted-foreground">
            Boutique {activeShop.name} — {total} produit(s)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/categories">
              <FolderTree aria-hidden />
              Catégories
            </Link>
          </Button>
          <Can permission={PERMISSIONS.PRODUCTS_CREATE}>
            <Button asChild>
              <Link href="/products/new">
                <Plus aria-hidden />
                Nouveau produit
              </Link>
            </Button>
          </Can>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder="Nom, slug ou SKU…"
            className="pl-8"
            aria-label="Rechercher un produit"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as 'ALL' | ProductStatus);
            resetPage();
          }}
        >
          <SelectTrigger className="w-36" aria-label="Filtrer par statut">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tous statuts</SelectItem>
            {(Object.keys(PRODUCT_STATUS_LABELS) as ProductStatus[]).map((status) => (
              <SelectItem key={status} value={status}>
                {PRODUCT_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={stockFilter}
          onValueChange={(value) => {
            setStockFilter(value as 'ALL' | StockStatus);
            resetPage();
          }}
        >
          <SelectTrigger className="w-40" aria-label="Filtrer par disponibilité">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Toute disponibilité</SelectItem>
            {(Object.keys(STOCK_STATUS_LABELS) as StockStatus[]).map((status) => (
              <SelectItem key={status} value={status}>
                {STOCK_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(value) => {
            setCategoryFilter(value);
            resetPage();
          }}
        >
          <SelectTrigger className="w-44" aria-label="Filtrer par catégorie">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Toutes catégories</SelectItem>
            {(categoriesQuery.data?.items ?? []).map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : products.length === 0 ? (
        <EmptyState
          title="Aucun produit"
          description="Créez votre premier produit — simple ou avec des déclinaisons (taille, couleur…)."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14" />
                <TableHead>Produit</TableHead>
                <TableHead>Catégorie</TableHead>
                <TableHead>Prix</TableHead>
                <TableHead>Variantes</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Disponibilité</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.id} data-testid="product-row">
                  <TableCell>
                    {product.primaryImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- URLs externes arbitraires (pas de domaine next/image configurable)
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
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/products/${product.id}`}
                      className="font-medium hover:text-primary hover:underline"
                    >
                      {product.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{product.slug}</p>
                  </TableCell>
                  <TableCell>
                    {product.category ? (
                      <span className="text-sm">
                        {product.category.name}
                        {product.category.status === 'ARCHIVED' ? (
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            archivée
                          </Badge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatMinorRange(product.minPriceMinor, product.maxPriceMinor, product.currency)}
                  </TableCell>
                  <TableCell>{product.variantCount}</TableCell>
                  <TableCell>
                    {product.totalAvailable === null ? '—' : product.totalAvailable}
                  </TableCell>
                  <TableCell>
                    <StockStatusBadge status={product.stockStatus} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={product.status === 'ACTIVE' ? 'secondary' : 'outline'}>
                      {PRODUCT_STATUS_LABELS[product.status]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Précédent
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} / {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Suivant
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
