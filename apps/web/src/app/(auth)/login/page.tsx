import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoginForm } from '@/features/auth/components/login-form';
import { AuthSplash, RedirectIfAuthenticated } from '@/lib/auth/require-auth';

export const metadata: Metadata = { title: 'Connexion' };

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <RedirectIfAuthenticated>
        <LoginForm />
      </RedirectIfAuthenticated>
    </Suspense>
  );
}
