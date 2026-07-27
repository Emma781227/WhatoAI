'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from '@/lib/auth/auth-provider';
import { getSafeInternalPath } from '@/lib/auth/safe-path';

/** Splash pendant l'initialisation : évite tout flash de contenu protégé. */
export function AuthSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background" role="status">
      <Loader2 aria-hidden className="h-6 w-6 animate-spin text-primary" />
      <span className="sr-only">Chargement…</span>
    </div>
  );
}

/**
 * Garde des routes authentifiées : n'agit qu'une fois l'initialisation
 * terminée (pas de boucle de redirection), conserve la destination dans
 * `next` (chemin interne uniquement).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (status === 'unauthenticated') {
      const query = searchParams.toString();
      const target = query ? `${pathname}?${query}` : pathname;
      router.replace(`/login?next=${encodeURIComponent(getSafeInternalPath(target, '/dashboard'))}`);
    }
  }, [status, router, pathname, searchParams]);

  if (status !== 'authenticated') {
    return <AuthSplash />;
  }
  return <>{children}</>;
}

/** Inverse : redirige vers le dashboard si déjà connecté (pages login/register). */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace(getSafeInternalPath(searchParams.get('next')));
    }
  }, [status, router, searchParams]);

  if (status === 'initializing') {
    return <AuthSplash />;
  }
  return <>{children}</>;
}
