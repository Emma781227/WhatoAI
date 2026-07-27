'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, MailWarning } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authApi } from '@/features/auth/api';
import { organizationKeys, organizationsApi } from '@/features/organizations/api';
import { OrganizationForm } from '@/features/organizations/components/organization-form';
import { shopKeys, shopsApi } from '@/features/shops/api';
import { QuickCreateShopForm } from '@/features/shops/components/quick-create-shop-form';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthSplash, RequireAuth } from '@/lib/auth/require-auth';
import { messages } from '@/lib/messages';

type OnboardingStep = 'verify-email' | 'create-organization' | 'create-shop' | 'done';

const STEP_LABELS: Array<{ id: OnboardingStep; label: string }> = [
  { id: 'verify-email', label: 'Vérifier votre email' },
  { id: 'create-organization', label: 'Créer votre organisation' },
  { id: 'create-shop', label: 'Créer votre première boutique' },
];

function StepIndicator({ current }: { current: OnboardingStep }) {
  const currentIndex = STEP_LABELS.findIndex((step) => step.id === current);
  return (
    <ol className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      {STEP_LABELS.map((step, index) => {
        const done = currentIndex === -1 || index < currentIndex;
        const active = step.id === current;
        return (
          <li key={step.id} className="flex items-center gap-2 text-sm">
            {done ? (
              <CheckCircle2 aria-hidden className="h-4 w-4 text-primary" />
            ) : (
              <Circle aria-hidden className={active ? 'h-4 w-4 text-primary' : 'h-4 w-4 text-muted-foreground'} />
            )}
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function OnboardingContent() {
  const { user, setUser } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [resendResult, setResendResult] = useState<{ message: string; devLink?: string } | null>(null);

  const emailVerified = user?.emailVerifiedAt !== null;

  const organizationsQuery = useQuery({
    queryKey: organizationKeys.list(),
    queryFn: () => organizationsApi.list(),
    enabled: emailVerified,
  });
  const organizations = organizationsQuery.data ?? [];
  const firstOrganization = organizations[0] ?? null;

  const shopsQuery = useQuery({
    queryKey: shopKeys.list(firstOrganization?.organization.id ?? 'none', { page: 1, limit: 1 }),
    queryFn: () => shopsApi.list(firstOrganization!.organization.id, { page: 1, limit: 1 }),
    enabled: firstOrganization !== null,
  });

  // Étape TOUJOURS dérivée de l'état réel — jamais stockée : un parcours
  // partiellement terminé reprend automatiquement au bon endroit.
  let step: OnboardingStep = 'verify-email';
  if (emailVerified) {
    if (!organizationsQuery.isSuccess) {
      step = 'verify-email'; // en attente de chargement — l'UI montre un splash
    } else if (!firstOrganization) {
      step = 'create-organization';
    } else if (!shopsQuery.isSuccess) {
      step = 'create-shop';
    } else if (shopsQuery.data.total === 0) {
      step = 'create-shop';
    } else {
      step = 'done';
    }
  }

  useEffect(() => {
    if (step === 'done') {
      router.replace('/dashboard');
    }
  }, [step, router]);

  if (
    (emailVerified && organizationsQuery.isPending) ||
    (firstOrganization && shopsQuery.isPending) ||
    step === 'done'
  ) {
    return <AuthSplash />;
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <h1 className="mb-1 text-2xl">Bienvenue sur {messages.app.name}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Quelques étapes pour préparer votre espace de vente WhatsApp.
      </p>
      <StepIndicator current={step} />

      {step === 'verify-email' ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailWarning aria-hidden className="h-5 w-5 text-warning" />
              Vérifiez votre adresse email
            </CardTitle>
            <CardDescription>
              Un lien de vérification a été envoyé à {user?.email}. Ouvrez-le puis revenez ici.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {resendResult ? (
              <Alert variant="info">
                <AlertDescription>
                  {resendResult.message}
                  {resendResult.devLink ? (
                    <>
                      {' '}
                      <Link
                        href={resendResult.devLink.replace(/^https?:\/\/[^/]+/, '')}
                        className="break-all font-medium underline"
                        target="_blank"
                      >
                        Lien de développement
                      </Link>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void authApi.resendVerification().then(setResendResult)}
              >
                Renvoyer l’email
              </Button>
              <Button onClick={() => void authApi.me().then(setUser)}>J’ai vérifié mon email</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'create-organization' ? (
        <Card>
          <CardHeader>
            <CardTitle>Votre organisation</CardTitle>
            <CardDescription>
              L’organisation représente votre entreprise. Vous pourrez inviter votre équipe ensuite.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationForm
              submitLabel="Créer l’organisation"
              onSubmit={async (values) => {
                await organizationsApi.create(values);
                await queryClient.invalidateQueries({ queryKey: organizationKeys.list() });
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {step === 'create-shop' && firstOrganization ? (
        <Card>
          <CardHeader>
            <CardTitle>Votre première boutique</CardTitle>
            <CardDescription>
              La boutique portera vos produits, conversations et commandes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QuickCreateShopForm
              organizationId={firstOrganization.organization.id}
              onCreated={() => {
                void queryClient.invalidateQueries({
                  queryKey: shopKeys.all(firstOrganization.organization.id),
                });
                router.replace('/dashboard');
              }}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <RequireAuth>
        <OnboardingContent />
      </RequireAuth>
    </Suspense>
  );
}
