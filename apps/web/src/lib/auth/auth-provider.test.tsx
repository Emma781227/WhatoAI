import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken, getAccessToken } from '@/lib/api/token-store';

import { AuthProvider, useAuth } from './auth-provider';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('@/features/auth/api', () => ({
  authApi: {
    refresh: refreshMock,
    logout: vi.fn(async () => undefined),
  },
}));

function fakeJwt(expiresInMs: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256' })}.${encode({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })}.sig`;
}

const USER = {
  id: 'user-1',
  email: 'a@b.cm',
  firstName: 'Aïcha',
  lastName: 'D',
  status: 'ACTIVE',
  emailVerifiedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

function StatusProbe() {
  const { status, user } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  refreshMock.mockReset();
});

afterEach(() => {
  clearAccessToken();
  vi.useRealTimers();
});

describe('AuthProvider', () => {
  it('bootstrap UNIQUE : un seul appel refresh, initializing → authenticated', async () => {
    refreshMock.mockResolvedValue({ user: USER, accessToken: fakeJwt(15 * 60_000) });

    renderProvider();
    expect(screen.getByTestId('status').textContent).toBe('initializing');

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('email').textContent).toBe('a@b.cm');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).not.toBeNull();
    // Jamais de token persisté.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('refresh refusé → unauthenticated, sans token', async () => {
    const { ApiError } = await import('@/lib/api/api-error');
    refreshMock.mockRejectedValue(new ApiError({ status: 401, code: 'INVALID_REFRESH_TOKEN', message: 'x' }));

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(getAccessToken()).toBeNull();
  });

  it('refresh préventif : replanifié ~60 s avant l’expiration du token', async () => {
    vi.useFakeTimers();
    // Token qui expire dans 3 minutes → refresh préventif attendu à T+2min.
    refreshMock.mockResolvedValue({ user: USER, accessToken: fakeJwt(3 * 60_000) });

    renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Avant l'échéance : rien.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Après exp-60s : refresh préventif déclenché (le 401 n'est qu'un secours).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });
});
