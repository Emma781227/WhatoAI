import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppBusinessProfile } from '../api';
import { WhatsAppProfileForm } from './whatsapp-profile-form';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/features/organizations/organization-provider', () => ({
  useOrganization: () => ({ activeOrganization: { organization: { id: 'org-1' } } }),
}));

const api = vi.hoisted(() => ({ getProfile: vi.fn(), updateProfile: vi.fn() }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    whatsappChannelsApi: { getProfile: api.getProfile, updateProfile: api.updateProfile },
  };
});

const PROFILE: WhatsAppBusinessProfile = {
  about: 'Boutique Douala',
  address: '',
  description: '',
  email: '',
  vertical: 'RETAIL',
  websites: ['https://boutique.example'],
  profilePictureUrl: null,
};

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<WhatsAppProfileForm shopId="shop-1" />, { wrapper });
}

afterEach(() => vi.clearAllMocks());

describe('WhatsAppProfileForm', () => {
  it('charge le profil serveur et pré-remplit les champs', async () => {
    api.getProfile.mockResolvedValue(PROFILE);
    renderForm();

    await waitFor(() =>
      expect((screen.getByLabelText('À propos') as HTMLInputElement).value).toBe('Boutique Douala'),
    );
    expect((screen.getByLabelText('Site web 1') as HTMLInputElement).value).toBe(
      'https://boutique.example',
    );
  });

  it('édite « À propos » et enregistre → PATCH avec les sites en tableau + toast succès', async () => {
    api.getProfile.mockResolvedValue(PROFILE);
    api.updateProfile.mockResolvedValue({ ...PROFILE, about: 'Nouvelle bio' });
    renderForm();

    const about = await screen.findByLabelText('À propos');
    fireEvent.change(about, { target: { value: 'Nouvelle bio' } });
    fireEvent.click(screen.getByRole('button', { name: /enregistrer/i }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    // Le tableau `websites` est reconstruit depuis les deux champs ; `about` est
    // repris. (La valeur du Select n'est pas assertée ici : Radix ne synchronise
    // pas sa valeur contrôlée sous jsdom — le round-trip vertical est couvert e2e.)
    expect(api.updateProfile).toHaveBeenCalledWith(
      'org-1',
      'shop-1',
      expect.objectContaining({
        about: 'Nouvelle bio',
        websites: ['https://boutique.example'],
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('erreur de chargement → message d’erreur, pas de formulaire', async () => {
    api.getProfile.mockRejectedValue(new Error('boom'));
    renderForm();
    await waitFor(() => expect(screen.getByTestId('profile-load-error')).toBeTruthy());
    expect(screen.queryByLabelText('À propos')).toBeNull();
  });
});
