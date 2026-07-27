'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CircleCheck, CirclePause, Settings, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/error-state';
import { PageHeader } from '@/components/layout/app-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/features/organizations/organization-provider';
import { shopKeys, shopsApi, type Shop } from '@/features/shops/api';
import { PrimaryShopBadge, ShopStatusBadge } from '@/features/shops/components/shop-badges';
import { BUSINESS_TYPE_LABELS } from '@/features/shops/schemas';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right">{value ?? '—'}</dd>
    </div>
  );
}

export default function ShopDetailPage() {
  const params = useParams<{ shopId: string }>();
  const { activeOrganization } = useOrganization();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const organizationId = activeOrganization.organization.id;
  const shopId = params.shopId;

  const shopQuery = useQuery({
    queryKey: shopKeys.detail(organizationId, shopId),
    queryFn: () => shopsApi.get(organizationId, shopId),
  });

  function shopMutation(action: (organizationId: string, shopId: string) => Promise<Shop>, successMessage: string) {
    return {
      mutationFn: () => action(organizationId, shopId),
      onSuccess: () => {
        toast.success(successMessage);
        void queryClient.invalidateQueries({ queryKey: shopKeys.all(organizationId) });
      },
      onError: (error: unknown) => {
        toast.error(getErrorMessage(error));
        void queryClient.invalidateQueries({ queryKey: shopKeys.all(organizationId) });
      },
    };
  }

  const activateMutation = useMutation(shopMutation(shopsApi.activate, 'Boutique activée'));
  const deactivateMutation = useMutation(shopMutation(shopsApi.deactivate, 'Boutique désactivée'));
  const setPrimaryMutation = useMutation(shopMutation(shopsApi.setPrimary, 'Boutique définie comme principale'));
  const archiveMutation = useMutation(shopMutation(shopsApi.archive, 'Boutique archivée'));

  if (shopQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  if (shopQuery.isError) {
    return <ErrorState error={shopQuery.error} onRetry={() => void shopQuery.refetch()} />;
  }

  const shop = shopQuery.data;
  const isArchived = shop.status === 'ARCHIVED';
  const isBusy =
    activateMutation.isPending ||
    deactivateMutation.isPending ||
    setPrimaryMutation.isPending ||
    archiveMutation.isPending;

  return (
    <div>
      <PageHeader
        title={shop.name}
        description={`/${shop.slug}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isArchived && can(PERMISSIONS.SHOPS_ACTIVATE) ? (
              <>
                {shop.status !== 'ACTIVE' ? (
                  <Button loading={activateMutation.isPending} disabled={isBusy} onClick={() => activateMutation.mutate()}>
                    <CircleCheck aria-hidden />
                    Activer
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    loading={deactivateMutation.isPending}
                    disabled={isBusy}
                    onClick={() => deactivateMutation.mutate()}
                  >
                    <CirclePause aria-hidden />
                    Désactiver
                  </Button>
                )}
                {!shop.isPrimary ? (
                  <Button
                    variant="outline"
                    loading={setPrimaryMutation.isPending}
                    disabled={isBusy}
                    onClick={() => setPrimaryMutation.mutate()}
                  >
                    <Star aria-hidden />
                    Définir principale
                  </Button>
                ) : null}
              </>
            ) : null}
            {!isArchived ? (
              <Can permission={PERMISSIONS.SHOPS_UPDATE}>
                <Button asChild variant="outline">
                  <Link href={`/shops/${shop.id}/settings`}>
                    <Settings aria-hidden />
                    Paramètres
                  </Link>
                </Button>
              </Can>
            ) : null}
            {!isArchived && can(PERMISSIONS.SHOPS_ARCHIVE) ? (
              <ConfirmDialog
                trigger={
                  <Button variant="outline" className="text-destructive" disabled={isBusy}>
                    <Archive aria-hidden />
                    Archiver
                  </Button>
                }
                title={`Archiver « ${shop.name} » ?`}
                description="L’archivage est définitif : la boutique deviendra non modifiable et sera exclue des listes. Si elle est principale, la plus ancienne boutique active la remplacera."
                confirmLabel="Archiver définitivement"
                destructive
                onConfirm={() => archiveMutation.mutate()}
              />
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <ShopStatusBadge status={shop.status} />
        {shop.isPrimary ? <PrimaryShopBadge /> : null}
      </div>

      {isArchived ? (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            Cette boutique est archivée
            {shop.archivedAt ? ` depuis le ${new Date(shop.archivedAt).toLocaleDateString('fr-FR')}` : ''} —
            consultation seule.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Informations</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <InfoRow label="Description" value={shop.description} />
              <InfoRow
                label="Type de commerce"
                value={shop.businessType ? BUSINESS_TYPE_LABELS[shop.businessType] : null}
              />
              <InfoRow label="Pays" value={shop.countryCode} />
              <InfoRow label="Fuseau horaire" value={shop.timezone} />
              <InfoRow label="Devise" value={shop.currency} />
              <InfoRow label="Langue" value={shop.locale} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Contact & adresse</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <InfoRow label="Email" value={shop.supportEmail} />
              <InfoRow label="Téléphone" value={shop.supportPhone} />
              <InfoRow label="Site web" value={shop.websiteUrl} />
              <InfoRow
                label="Adresse"
                value={
                  [shop.addressLine1, shop.addressLine2, shop.postalCode, shop.city, shop.region]
                    .filter(Boolean)
                    .join(', ') || null
                }
              />
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
