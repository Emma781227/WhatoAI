import type { Metadata } from 'next';
import { Suspense } from 'react';

import { VerifyEmailCard } from '@/features/auth/components/verify-email-card';
import { AuthSplash } from '@/lib/auth/require-auth';

export const metadata: Metadata = { title: 'Vérification email' };

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthSplash />}>
      <VerifyEmailCard />
    </Suspense>
  );
}
