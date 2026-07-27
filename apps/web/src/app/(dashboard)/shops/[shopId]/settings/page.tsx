'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';

import { ErrorState } from '@/components/feedback/error-state';
import { PageHeader } from '@/components/layout/app-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrganization } from '@/features/organizations/organization-provider';
import { shopKeys, shopsApi } from '@/features/shops/api';
import { OpeningHoursEditor } from '@/features/shops/components/opening-hours-editor';
import { ShopForm } from '@/features/shops/components/shop-form';
import { buildShopPatch, shopToFormValues } from '@/features/shops/patch';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

export default function ShopSettingsPage() {
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

  const hoursQuery = useQuery({
    queryKey: shopKeys.openingHours(organizationId, shopId),
    queryFn: () => shopsApi.getOpeningHours(organizationId, shopId),
  });

  if (shopQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (shopQuery.isError) {
    return <ErrorState error={shopQuery.error} onRetry={() => void shopQuery.refetch()} />;
  }

  const shop = shopQuery.data;
  const canUpdate = can(PERMISSIONS.SHOPS_UPDATE) && shop.status !== 'ARCHIVED';
  const canManageHours = can(PERMISSIONS.SHOPS_MANAGE_SETTINGS) && shop.status !== 'ARCHIVED';

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`Paramètres — ${shop.name}`}
        actions={
          <Button asChild variant="outline">
            <Link href={`/shops/${shop.id}`}>
              <ArrowLeft aria-hidden />
              Retour à la boutique
            </Link>
          </Button>
        }
      />

      {shop.status === 'ARCHIVED' ? (
        <Alert variant="warning" className="mb-6">
          <AlertDescription>Boutique archivée : les paramètres ne sont plus modifiables.</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-6">
        {canUpdate ? (
          <Card>
            <CardHeader>
              <CardTitle>Informations de la boutique</CardTitle>
              <CardDescription>
                Seuls les champs modifiés sont envoyés ; vider un champ optionnel l’efface.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ShopForm
                mode="edit"
                defaultValues={shopToFormValues(shop)}
                onSubmit={async (values, form) => {
                  const patch = buildShopPatch(form.formState.dirtyFields, values);
                  if (Object.keys(patch).length === 0) {
                    toast.info('Aucune modification à enregistrer');
                    return;
                  }
                  const updated = await shopsApi.update(organizationId, shopId, patch);
                  await queryClient.invalidateQueries({ queryKey: shopKeys.all(organizationId) });
                  form.reset(shopToFormValues(updated));
                  toast.success('Boutique mise à jour');
                }}
              />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Horaires d’ouverture</CardTitle>
            <CardDescription>
              Fuseau horaire de la boutique : {shop.timezone}. Un jour sans plage est fermé.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hoursQuery.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : hoursQuery.isError ? (
              <ErrorState error={hoursQuery.error} onRetry={() => void hoursQuery.refetch()} />
            ) : (
              <OpeningHoursEditor
                // key force la réinitialisation quand les données serveur changent.
                key={JSON.stringify(hoursQuery.data.days)}
                initialDays={hoursQuery.data.days}
                readOnly={!canManageHours}
                onSave={async (days) => {
                  await shopsApi.replaceOpeningHours(organizationId, shopId, days);
                  await queryClient.invalidateQueries({
                    queryKey: shopKeys.openingHours(organizationId, shopId),
                  });
                }}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
