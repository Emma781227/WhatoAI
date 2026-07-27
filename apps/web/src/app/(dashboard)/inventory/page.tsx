'use client';

import { useQuery } from '@tanstack/react-query';
import { History, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { inventoryApi, inventoryKeys, type InventoryRow, type Movement } from '@/features/inventory/api';
import { AdjustInventoryDialog } from '@/features/inventory/components/adjust-dialog';
import { useOrganization } from '@/features/organizations/organization-provider';
import { StockStatusBadge } from '@/features/products/components/stock-status-badge';
import { formatMinorAmount } from '@/features/products/money';
import { useActiveShop } from '@/features/shops/shop-provider';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';
import { cn } from '@/lib/utils';

const MOVEMENT_LABELS: Record<Movement['type'], string> = {
  INITIAL: 'Stock initial',
  ADJUSTMENT: 'Correction',
  RESTOCK: 'Réappro',
  DAMAGE: 'Casse',
  RETURN: 'Retour',
  RESERVATION: 'Réservation',
  RELEASE: 'Libération',
  SALE: 'Vente',
  CANCELLATION: 'Annulation',
};

function MovementsDialog({
  row,
  shopId,
  onClose,
}: {
  row: InventoryRow;
  shopId: string;
  onClose: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: inventoryKeys.movements(organizationId, shopId, row.variantId, page),
    queryFn: () => inventoryApi.listMovements(organizationId, shopId, row.variantId, { page, limit: 20 }),
  });

  const movements = query.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 20));

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Historique des mouvements</DialogTitle>
          <DialogDescription>
            {row.productName}
            {row.variantName ? ` — ${row.variantName}` : ''} · {row.sku} — historique immuable
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : movements.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Aucun mouvement.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Delta</TableHead>
                <TableHead>Avant → Après</TableHead>
                <TableHead>Raison</TableHead>
                <TableHead>Par</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((movement) => (
                <TableRow key={movement.id} data-testid="movement-row">
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(movement.createdAt).toLocaleString('fr-FR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell>{MOVEMENT_LABELS[movement.type]}</TableCell>
                  <TableCell
                    className={cn(
                      'font-medium',
                      movement.quantityDelta > 0 ? 'text-primary' : 'text-destructive',
                    )}
                  >
                    {movement.quantityDelta > 0 ? '+' : ''}
                    {movement.quantityDelta}
                  </TableCell>
                  <TableCell>
                    {movement.quantityBefore} → {movement.quantityAfter}
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs text-muted-foreground">
                    {movement.reason ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {movement.actor ? `${movement.actor.firstName} ${movement.actor.lastName}` : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {totalPages > 1 ? (
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Précédent
            </Button>
            <span className="text-sm text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Suivant
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function InventoryPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const { can } = usePermissions();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'LOW_STOCK' | 'OUT_OF_STOCK'>('ALL');
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);
  const [viewingMovements, setViewingMovements] = useState<InventoryRow | null>(null);

  const shopId = activeShop?.id ?? '';
  const params = {
    page,
    limit: 20,
    search: search.trim() === '' ? undefined : search.trim(),
    stockStatus: filter === 'ALL' ? undefined : filter,
  };
  const query = useQuery({
    queryKey: inventoryKeys.list(organizationId, shopId, params),
    queryFn: () => inventoryApi.list(organizationId, shopId, params),
    enabled: activeShop !== null,
  });

  if (!activeShop) {
    return (
      <EmptyState title="Aucune boutique" description="Créez une boutique pour suivre son stock." />
    );
  }

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold">Inventaire</h1>
          <p className="text-sm text-muted-foreground">
            Boutique {activeShop.name} — {total} variante(s) suivie(s)
          </p>
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
                setPage(1);
              }}
              placeholder="Produit ou SKU…"
              className="pl-8"
              aria-label="Rechercher dans l’inventaire"
            />
          </div>
          <Button
            type="button"
            variant={filter === 'LOW_STOCK' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setFilter((current) => (current === 'LOW_STOCK' ? 'ALL' : 'LOW_STOCK'));
              setPage(1);
            }}
            aria-pressed={filter === 'LOW_STOCK'}
          >
            Stock faible
          </Button>
          <Button
            type="button"
            variant={filter === 'OUT_OF_STOCK' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setFilter((current) => (current === 'OUT_OF_STOCK' ? 'ALL' : 'OUT_OF_STOCK'));
              setPage(1);
            }}
            aria-pressed={filter === 'OUT_OF_STOCK'}
          >
            Rupture
          </Button>
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucun stock suivi"
          description="Les variantes physiques avec suivi de stock apparaissent ici."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>Variante</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Prix</TableHead>
                <TableHead>Disponible</TableHead>
                <TableHead>Réservé</TableHead>
                <TableHead>Seuil</TableHead>
                <TableHead>État</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.variantId} data-testid="inventory-row">
                  <TableCell className="font-medium">{row.productName}</TableCell>
                  <TableCell>{row.variantName ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{row.sku}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatMinorAmount(row.priceMinor, row.currency)}
                  </TableCell>
                  <TableCell
                    className={cn('font-medium', row.quantityAvailable < 0 && 'text-destructive')}
                  >
                    {row.quantityAvailable}
                  </TableCell>
                  <TableCell>{row.quantityReserved}</TableCell>
                  <TableCell>{row.lowStockThreshold}</TableCell>
                  <TableCell>
                    <StockStatusBadge status={row.stockStatus} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {can(PERMISSIONS.INVENTORY_VIEW_MOVEMENTS) ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setViewingMovements(row)}
                          aria-label={`Historique de ${row.sku}`}
                        >
                          <History aria-hidden className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {can(PERMISSIONS.INVENTORY_ADJUST) ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setAdjusting(row)}
                          aria-label={`Ajuster ${row.sku}`}
                        >
                          <SlidersHorizontal aria-hidden className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
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

      {adjusting ? (
        <AdjustInventoryDialog row={adjusting} shopId={shopId} onClose={() => setAdjusting(null)} />
      ) : null}
      {viewingMovements ? (
        <MovementsDialog
          row={viewingMovements}
          shopId={shopId}
          onClose={() => setViewingMovements(null)}
        />
      ) : null}
    </div>
  );
}
