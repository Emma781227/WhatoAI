import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/api-error';

/**
 * Politique de retry : jamais sur une erreur 4xx (401 est déjà géré par le
 * refresh coordonné du client API ; 403/404/409 sont des états, pas des
 * pannes) — un seul retry sur le reste (réseau, 5xx).
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
