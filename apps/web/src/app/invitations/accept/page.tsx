'use client';

import { useQueryClient } from '@tanstack/react-query';
import { MailQuestion } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { organizationKeys } from '@/features/organizations/api';
import { invitationsApi } from '@/features/invitations/api';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { useAuth } from '@/lib/auth/auth-provider';
import { AuthSplash, RequireAuth } from '@/lib/auth/require-auth';
import { messages } from '@/lib/messages';

function AcceptInvitationContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // Token en mémoire uniquement, retiré de l'URL, jamais loggé.
  const tokenRef = useRef<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      tokenRef.current = token;
      router.replace('/invitations/accept');
    }
    setTokenReady(true);
  }, [searchParams, router]);

  async function accept() {
    if (!tokenRef.current) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await invitationsApi.accept(tokenRef.current);
      tokenRef.current = null;
      await queryClient.invalidateQueries({ queryKey: organizationKeys.list() });
      toast.success(`Vous avez rejoint ${result.organization.name}`);
      router.replace('/dashboard');
    } catch (acceptError) {
      if (acceptError instanceof ApiError && acceptError.code === 'EMAIL_NOT_VERIFIED') {
        setError('Vérifiez d’abord votre adresse email, puis rouvrez le lien d’invitation.');
      } else {
        setError(getErrorMessage(acceptError));
      }
      setSubmitting(false);
    }
  }

  async function decline() {
    if (!tokenRef.current) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await invitationsApi.decline(tokenRef.current);
      tokenRef.current = null;
      toast.success('Invitation refusée');
      router.replace('/dashboard');
    } catch (declineError) {
      setError(getErrorMessage(declineError));
      setSubmitting(false);
    }
  }

  if (!tokenReady) {
    return <AuthSplash />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailQuestion aria-hidden className="h-5 w-5 text-primary" />
            Invitation à rejoindre une organisation
          </CardTitle>
          <CardDescription>
            {tokenRef.current
              ? `Connecté en tant que ${user?.email}. Acceptez pour rejoindre l’organisation avec le rôle proposé.`
              : 'Aucun lien d’invitation détecté. Ouvrez le lien reçu par email.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {tokenRef.current ? (
            <div className="flex gap-2">
              <Button className="flex-1" loading={submitting} onClick={() => void accept()}>
                Accepter
              </Button>
              <Button variant="outline" className="flex-1" disabled={submitting} onClick={() => void decline()}>
                Refuser
              </Button>
            </div>
          ) : (
            <Button asChild variant="outline" className="w-full">
              <Link href="/dashboard">{messages.nav.dashboard}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <RequireAuth>
        <AcceptInvitationContent />
      </RequireAuth>
    </Suspense>
  );
}
