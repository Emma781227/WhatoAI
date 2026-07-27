'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Plus } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PageHeader } from '@/components/layout/app-shell';
import { ErrorState } from '@/components/feedback/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { organizationKeys, organizationsApi } from '@/features/organizations/api';
import { OrganizationForm } from '@/features/organizations/components/organization-form';
import { useOrganization } from '@/features/organizations/organization-provider';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';
import { messages } from '@/lib/messages';

export default function OrganizationsPage() {
  const { organizations, activeOrganization, switchOrganization } = useOrganization();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const organizationId = activeOrganization.organization.id;

  const detailQuery = useQuery({
    queryKey: organizationKeys.detail(organizationId),
    queryFn: () => organizationsApi.get(organizationId),
  });

  return (
    <div>
      <PageHeader
        title="Organisations"
        description="Vos organisations et les paramètres de l’organisation active."
        actions={
          <Button asChild>
            <Link href="/organizations/new">
              <Plus aria-hidden />
              Nouvelle organisation
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Mes organisations</CardTitle>
            <CardDescription>Cliquez pour changer d’organisation active.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {organizations.map((membership) => {
              const isActive = membership.organization.id === organizationId;
              return (
                <button
                  key={membership.organization.id}
                  onClick={() => switchOrganization(membership.organization.id)}
                  className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-accent"
                >
                  <Building2 aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {membership.organization.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {membership.organization.slug}
                    </span>
                  </span>
                  <Badge variant="secondary">{messages.roles[membership.role]}</Badge>
                  {membership.organization.status !== 'ACTIVE' ? (
                    <Badge variant="warning">{membership.organization.status}</Badge>
                  ) : null}
                  {isActive ? <Check aria-hidden className="h-4 w-4 text-primary" /> : null}
                </button>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Paramètres de {activeOrganization.organization.name}</CardTitle>
            <CardDescription>
              {can(PERMISSIONS.ORGANIZATION_UPDATE)
                ? 'Nom, slug et paramètres régionaux par défaut.'
                : 'Lecture seule — votre rôle ne permet pas la modification.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {detailQuery.isPending ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-2/3" />
              </div>
            ) : detailQuery.isError ? (
              <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
            ) : (
              <>
                <Can permission={PERMISSIONS.ORGANIZATION_UPDATE}>
                  <OrganizationForm
                    defaultValues={{
                      name: detailQuery.data.name,
                      slug: detailQuery.data.slug,
                      timezone: detailQuery.data.timezone,
                      defaultCurrency: detailQuery.data.defaultCurrency,
                      defaultLocale: detailQuery.data.defaultLocale,
                    }}
                    onSubmit={async (values) => {
                      await organizationsApi.update(organizationId, values);
                      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
                      toast.success('Organisation mise à jour');
                    }}
                  />
                </Can>
                {!can(PERMISSIONS.ORGANIZATION_UPDATE) ? (
                  <dl className="grid gap-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Nom</dt>
                      <dd>{detailQuery.data.name}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Fuseau horaire</dt>
                      <dd>{detailQuery.data.timezone}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Devise</dt>
                      <dd>{detailQuery.data.defaultCurrency}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Membres</dt>
                      <dd>{detailQuery.data.memberCount}</dd>
                    </div>
                  </dl>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
