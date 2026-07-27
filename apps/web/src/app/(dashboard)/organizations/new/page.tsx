'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { organizationKeys, organizationsApi } from '@/features/organizations/api';
import { OrganizationForm } from '@/features/organizations/components/organization-form';
import { useOrganization } from '@/features/organizations/organization-provider';

export default function NewOrganizationPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { switchOrganization } = useOrganization();

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Nouvelle organisation"
        description="Vous en deviendrez propriétaire (OWNER)."
      />
      <Card>
        <CardContent className="pt-6">
          <OrganizationForm
            submitLabel="Créer l’organisation"
            onSubmit={async (values) => {
              const result = await organizationsApi.create(values);
              await queryClient.invalidateQueries({ queryKey: organizationKeys.list() });
              toast.success(`Organisation « ${result.organization.name} » créée`);
              switchOrganization(result.organization.id);
              router.push('/dashboard');
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
