import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ResetPasswordForm } from '@/features/auth/components/reset-password-form';
import { AuthSplash } from '@/lib/auth/require-auth';

export const metadata: Metadata = { title: 'Réinitialisation du mot de passe' };

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
