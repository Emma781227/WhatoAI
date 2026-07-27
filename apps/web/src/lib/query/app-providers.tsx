'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import { AuthProvider } from '@/lib/auth/auth-provider';

import { createQueryClient } from './query-client';

export function AppProviders({ children }: { children: ReactNode }) {
  // useState garantit une seule instance par montage, sans partage entre requêtes SSR.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
      {/* bottom-right : ne recouvre jamais les actions d'en-tête de page. */}
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
