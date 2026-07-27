'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot, MessagesSquare, Package, Plus, Store, Users } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { organizationKeys, organizationsApi } from '@/features/organizations/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { shopKeys, shopsApi } from '@/features/shops/api';
import { PrimaryShopBadge, ShopStatusBadge } from '@/features/shops/components/shop-badges';
import { useAuth } from '@/lib/auth/auth-provider';
import { messages } from '@/lib/messages';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can } from '@/lib/permissions/use-permissions';

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Store }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Cartes des futurs modules — clairement non fonctionnelles, aucun faux chiffre. */
function ComingSoonCard({ title, icon: Icon }: { title: string; icon: typeof Store }) {
  return (
    <Card className="opacity-70">
      <CardContent className="flex items-center gap-4 pt-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
        <div>
          <p className="font-medium">{title}</p>
          <Badge variant="muted" className="mt-1">
            {messages.nav.comingSoon}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;

  const detailQuery = useQuery({
    queryKey: organizationKeys.detail(organizationId),
    queryFn: () => organizationsApi.get(organizationId),
  });
  const shopsQuery = useQuery({
    queryKey: shopKeys.list(organizationId, { page: 1, limit: 100 }),
    queryFn: () => shopsApi.list(organizationId, { page: 1, limit: 100 }),
  });

  const primaryShop = shopsQuery.data?.items.find((shop) => shop.isPrimary) ?? null;

  return (
    <div>
      <PageHeader
        title={`Bonjour${user ? ` ${user.firstName}` : ''} 👋`}
        description={`Vue d’ensemble de ${activeOrganization.organization.name}`}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shopsQuery.isPending || detailQuery.isPending ? (
          <>
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
          </>
        ) : (
          <>
            <StatCard label="Boutiques" value={String(shopsQuery.data?.total ?? 0)} icon={Store} />
            <StatCard label="Membres" value={String(detailQuery.data?.memberCount ?? 0)} icon={Users} />
            <Card>
              <CardContent className="pt-6">
                <p className="mb-1 text-xs text-muted-foreground">Boutique principale</p>
                {primaryShop ? (
                  <Link href={`/shops/${primaryShop.id}`} className="group">
                    <p className="truncate font-semibold group-hover:text-primary">{primaryShop.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <ShopStatusBadge status={primaryShop.status} />
                      <PrimaryShopBadge />
                    </div>
                  </Link>
                ) : (
                  <div>
                    <p className="text-sm text-muted-foreground">Aucune boutique principale</p>
                    <Can permission={PERMISSIONS.SHOPS_CREATE}>
                      <Button asChild size="sm" className="mt-2">
                        <Link href="/shops/new">
                          <Plus aria-hidden />
                          Créer une boutique
                        </Link>
                      </Button>
                    </Can>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Prochaines étapes</CardTitle>
          <CardDescription>
            Les modules ci-dessous arrivent bientôt — ils s’appuieront sur vos boutiques.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ComingSoonCard title={messages.nav.conversations} icon={MessagesSquare} />
          <ComingSoonCard title={messages.nav.products} icon={Package} />
          <ComingSoonCard title={messages.nav.aiAgent} icon={Bot} />
        </CardContent>
      </Card>
    </div>
  );
}
