import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddedSignupError, type EmbeddedSignupResult } from '@/lib/meta/embedded-signup';

import { MetaConnectButton } from './meta-connect-button';

// --- Mocks externes ---------------------------------------------------------
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/features/organizations/organization-provider', () => ({
  useOrganization: () => ({ activeOrganization: { organization: { id: 'org-1' } } }),
}));

const embeddedSignup = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
  whatsappChannelsApi: { embeddedSignup: (...args: unknown[]) => embeddedSignup(...args) },
  whatsappChannelKeys: {
    forShop: (organizationId: string, shopId: string) => ['ch', organizationId, shopId],
  },
}));

const SESSION: EmbeddedSignupResult = {
  code: 'CODE-1',
  wabaId: 'WABA-1',
  phoneNumberId: 'PHONE-1',
  businessId: 'BM-1',
};

function renderButton(launch: () => Promise<EmbeddedSignupResult>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<MetaConnectButton shopId="shop-1" launch={launch} />, { wrapper });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MetaConnectButton', () => {
  it('succès : lance le SDK → POST embedded-signup avec le code capturé → toast succès', async () => {
    embeddedSignup.mockResolvedValue({ id: 'chan-1', status: 'CONNECTED' });
    renderButton(() => Promise.resolve(SESSION));

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(embeddedSignup).toHaveBeenCalledWith('org-1', 'shop-1', SESSION);
    });
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('annulation utilisateur : toast info, jamais d’appel backend', async () => {
    renderButton(() =>
      Promise.reject(new EmbeddedSignupError('annulé', 'CANCELLED')),
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(embeddedSignup).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('session incomplète : toast erreur, jamais d’appel backend', async () => {
    renderButton(() =>
      Promise.reject(new EmbeddedSignupError('incomplet', 'INCOMPLETE_SESSION')),
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(embeddedSignup).not.toHaveBeenCalled();
  });

  it('échec backend : toast erreur (le frontend ne confirme jamais seul)', async () => {
    embeddedSignup.mockRejectedValue(new Error('boom'));
    renderButton(() => Promise.resolve(SESSION));

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
