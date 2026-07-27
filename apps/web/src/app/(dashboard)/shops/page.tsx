'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Store } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { shopKeys, shopsApi, type ShopStatus } from '@/features/shops/api';
import { PrimaryShopBadge, ShopStatusBadge } from '@/features/shops/components/shop-badges';
import { useOrganization } from '@/features/organizations/organization-provider';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can } from '@/lib/permissions/use-permissions';

const PAGE_SIZE = 12;
type StatusFilter = ShopStatus | 'ALL';

export default function ShopsPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [page, setPage] = useState(1);

  const params = {
    page,
    limit: PAGE_SIZE,
    search: search.trim() || undefined,
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    includeArchived: statusFilter === 'ARCHIVED' ? true : undefined,
  };

  const shopsQuery = useQuery({
    queryKey: shopKeys.list(organizationId, params),
    queryFn: () => shopsApi.list(organizationId, params),
  });

  const totalPages = shopsQuery.data ? Math.max(1, Math.ceil(shopsQuery.data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <PageHeader
        title="Boutiques"
        description={`Boutiques de ${activeOrganization.organization.name}`}
        actions={
          <Can permission={PERMISSIONS.SHOPS_CREATE}>
            <Button asChild>
              <Link href="/shops/new">
                <Plus aria-hidden />
                Nouvelle boutique
              </Link>
            </Button>
          </Can>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Rechercher (nom ou slug)…"
            aria-label="Rechercher une boutique"
            className="w-64 pl-9"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as StatusFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Filtrer par statut">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Tous les statuts</SelectItem>
            <SelectItem value="DRAFT">Brouillon</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="INACTIVE">Inactive</SelectItem>
            <SelectItem value="ARCHIVED">Archivée</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {shopsQuery.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-36 rounded-card" />
        </div>
      ) : shopsQuery.isError ? (
        <ErrorState error={shopsQuery.error} onRetry={() => void shopsQuery.refetch()} />
      ) : shopsQuery.data.items.length === 0 ? (
        <EmptyState
          icon={Store}
          title={search ? 'Aucun résultat' : 'Aucune boutique'}
          description={
            search
              ? 'Aucune boutique ne correspond à votre recherche.'
              : 'Créez votre première boutique pour démarrer.'
          }
          action={
            !search ? (
              <Can permission={PERMISSIONS.SHOPS_CREATE}>
                <Button asChild>
                  <Link href="/shops/new">
                    <Plus aria-hidden />
                    Créer une boutique
                  </Link>
                </Button>
              </Can>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shopsQuery.data.items.map((shop) => (
              <Link key={shop.id} href={`/shops/${shop.id}`} className="group">
                <Card className="h-full transition-shadow group-hover:shadow-popover">
                  <CardContent className="pt-6">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <h3 className="min-w-0 truncate text-base font-semibold">{shop.name}</h3>
                      {shop.isPrimary ? <PrimaryShopBadge /> : null}
                    </div>
                    <p className="mb-3 truncate text-xs text-muted-foreground">/{shop.slug}</p>
                    <div className="flex items-center gap-2">
                      <ShopStatusBadge status={shop.status} />
                      <span className="text-xs text-muted-foreground">
                        {shop.currency} · {shop.countryCode}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {page} sur {totalPages} · {shopsQuery.data.total} boutiques
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Précédent
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Suivant
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
