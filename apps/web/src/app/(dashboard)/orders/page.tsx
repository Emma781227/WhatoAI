'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
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
import { orderKeys, ordersApi, type OrderStatus } from '@/features/orders/api';
import {
  FulfillmentStatusBadge,
  OrderStatusBadge,
  PaymentStatusBadge,
} from '@/features/orders/components/order-badges';
import { FULFILLMENT_TYPE_LABELS, ORDER_STATUS_LABELS } from '@/features/orders/labels';
import { useOrganization } from '@/features/organizations/organization-provider';
import { formatMinorAmount } from '@/features/products/money';
import { useActiveShop } from '@/features/shops/shop-provider';

const ALL = '__all__';

export default function OrdersPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  const limit = 20;

  const filters = {
    page,
    limit,
    search: search.trim() === '' ? undefined : search.trim(),
    shopId: activeShop?.id,
    status: status === ALL ? undefined : (status as OrderStatus),
  };
  const listQuery = useQuery({
    queryKey: orderKeys.list(organizationId, filters),
    queryFn: () => ordersApi.list(organizationId, filters),
    enabled: activeShop !== null,
  });

  if (!activeShop) {
    return (
      <EmptyState
        title="Aucune boutique"
        description="Créez une boutique pour enregistrer des commandes."
      />
    );
  }

  const data = listQuery.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Commandes</h1>
          <p className="text-sm text-muted-foreground">
            Documents commerciaux historiques — les données affichées sont les snapshots au moment
            de la commande.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
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
            placeholder="Numéro, client, téléphone…"
            className="w-64 pl-8"
            aria-label="Rechercher une commande"
          />
        </div>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Filtrer par statut">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tous statuts</SelectItem>
            {(Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).map((value) => (
              <SelectItem key={value} value={value}>
                {ORDER_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title="Aucune commande"
          description="Les commandes créées depuis les conversations apparaîtront ici."
        />
      ) : data ? (
        <>
          <div className="overflow-x-auto rounded-card border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Numéro</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Montant</TableHead>
                  <TableHead>Commande</TableHead>
                  <TableHead>Paiement</TableHead>
                  <TableHead>Livraison</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((order) => (
                  <TableRow key={order.id} data-testid="order-row">
                    <TableCell>
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="block">{order.customerName}</span>
                      <span className="text-xs text-muted-foreground">{order.customerPhone}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {new Date(order.createdAt).toLocaleDateString('fr-FR')}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-medium">
                      {formatMinorAmount(order.totalMinor, order.currency)}
                    </TableCell>
                    <TableCell>
                      <OrderStatusBadge status={order.status} />
                    </TableCell>
                    <TableCell>
                      <PaymentStatusBadge status={order.paymentStatus} />
                    </TableCell>
                    <TableCell>
                      <FulfillmentStatusBadge status={order.fulfillmentStatus} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {FULFILLMENT_TYPE_LABELS[order.fulfillmentType]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
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
                onClick={() => setPage((current) => current + 1)}
              >
                Suivant
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
