import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationProvider, useOrganization } from './organization-provider';

const { listMock, replaceMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, organizationsApi: { ...original.organizationsApi, list: listMock } };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

function membership(id: string, name: string) {
  return {
    organization: {
      id,
      name,
      slug: name.toLowerCase(),
      status: 'ACTIVE',
      timezone: 'Africa/Douala',
      defaultCurrency: 'XAF',
      defaultLocale: 'fr',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    membershipId: `membership-${id}`,
    role: 'OWNER',
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

function ActiveOrgProbe() {
  const { activeOrganization } = useOrganization();
  return <span data-testid="active">{activeOrganization.organization.name}</span>;
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrganizationProvider>
        <ActiveOrgProbe />
      </OrganizationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe('OrganizationProvider', () => {
  it('préférence localStorage valide → organisation active correspondante', async () => {
    listMock.mockResolvedValue([membership('org-1', 'Alpha'), membership('org-2', 'Beta')]);
    localStorage.setItem('whauto:active-org', 'org-2');

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('Beta'));
  });

  it('préférence invalide (organisation quittée) → revalidée : première organisation', async () => {
    listMock.mockResolvedValue([membership('org-1', 'Alpha'), membership('org-2', 'Beta')]);
    localStorage.setItem('whauto:active-org', 'org-disparue');

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('Alpha'));
  });

  it('aucune organisation → redirection /onboarding', async () => {
    listMock.mockResolvedValue([]);

    renderProvider();
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/onboarding'));
    expect(screen.queryByTestId('active')).not.toBeInTheDocument();
  });
});
