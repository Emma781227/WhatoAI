'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { useOrganization } from '@/features/organizations/organization-provider';
import { shopKeys, shopsApi } from '@/features/shops/api';
import { ShopForm } from '@/features/shops/components/shop-form';
import { buildShopCreateInput } from '@/features/shops/patch';

export default function NewShopPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const router = useRouter();
  const queryClient = useQueryClient();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Nouvelle boutique"
        description="Fuseau, devise et langue sont pré-remplis depuis l’organisation."
      />
      <Card>
        <CardContent className="pt-6">
          <ShopForm
            mode="create"
            defaultValues={{
              timezone: activeOrganization.organization.timezone,
              currency: activeOrganization.organization.defaultCurrency,
              locale: activeOrganization.organization.defaultLocale,
            }}
            submitLabel="Créer la boutique"
            onSubmit={async (values) => {
              const shop = await shopsApi.create(organizationId, buildShopCreateInput(values));
              await queryClient.invalidateQueries({ queryKey: shopKeys.all(organizationId) });
              toast.success(`Boutique « ${shop.name} » créée`);
              router.push(`/shops/${shop.id}`);
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
