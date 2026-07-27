'use client';

import { CheckCircle2, MailWarning } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getErrorMessage } from '@/lib/api/api-error';
import { useAuth } from '@/lib/auth/auth-provider';

import { authApi } from '../api';

type VerifyState =
  | { kind: 'no-token' }
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export function VerifyEmailCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, user, setUser } = useAuth();
  const [state, setState] = useState<VerifyState>({ kind: 'no-token' });
  const [resendResult, setResendResult] = useState<{ message: string; devLink?: string } | null>(null);
  // Token conservé UNIQUEMENT en mémoire, retiré de l'URL immédiatement,
  // jamais loggé ni transmis à un quelconque outil tiers.
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    const token = searchParams.get('token');
    if (!token) {
      return;
    }
    startedRef.current = true;
    tokenRef.current = token;
    router.replace('/verify-email');
    setState({ kind: 'verifying' });

    void authApi
      .verifyEmail(token)
      .then((verifiedUser) => {
        tokenRef.current = null;
        setState({ kind: 'success' });
        if (user && user.id === verifiedUser.id) {
          setUser(verifiedUser);
        }
      })
      .catch((error: unknown) => {
        tokenRef.current = null;
        setState({ kind: 'error', message: getErrorMessage(error) });
      });
  }, [searchParams, router, setUser, user]);

  async function resend() {
    setResendResult(await authApi.resendVerification());
  }

  if (state.kind === 'success') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 aria-hidden className="h-5 w-5 text-primary" />
            Email vérifié
          </CardTitle>
          <CardDescription>Votre compte est actif. Vous pouvez continuer.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href={status === 'authenticated' ? '/onboarding' : '/login'}>
              {status === 'authenticated' ? 'Continuer' : 'Se connecter'}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailWarning aria-hidden className="h-5 w-5 text-warning" />
          Vérification de l’email
        </CardTitle>
        <CardDescription>
          {state.kind === 'verifying'
            ? 'Vérification en cours…'
            : 'Ouvrez le lien reçu par email pour vérifier votre adresse.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.kind === 'error' ? (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
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
                  >
                    Lien de développement
                  </Link>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {status === 'authenticated' && user?.emailVerifiedAt === null ? (
          <Button variant="outline" className="w-full" onClick={() => void resend()}>
            Renvoyer l’email de vérification
          </Button>
        ) : null}
        {status !== 'authenticated' ? (
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Se connecter</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
