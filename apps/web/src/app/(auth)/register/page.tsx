import type { Metadata } from 'next';
import { Suspense } from 'react';

import { RegisterForm } from '@/features/auth/components/register-form';
import { AuthSplash, RedirectIfAuthenticated } from '@/lib/auth/require-auth';

export const metadata: Metadata = { title: 'Créer un compte' };

export default function RegisterPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <RedirectIfAuthenticated>
        <RegisterForm />
      </RedirectIfAuthenticated>
    </Suspense>
  );
}
