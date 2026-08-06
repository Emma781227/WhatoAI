import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TopUp } from '@/features/wallet/api';

import BillingReturnPage from './page';

vi.mock('@/features/organizations/organization-provider', () => ({
  useOrganization: () => ({ activeOrganization: { organization: { id: 'org1' } } }),
}));

const mockGetPending = vi.fn<[], string | null>();
const mockClear = vi.fn();
vi.mock('@/features/wallet/pending-payment', () => ({
  getPendingTopUp: () => mockGetPending(),
  clearPendingTopUp: () => mockClear(),
}));

const mockUseTopUp = vi.fn();
vi.mock('@/features/wallet/use-wallet', () => ({ useTopUp: () => mockUseTopUp() }));

function setTopUp(data: Partial<TopUp> | undefined) {
  mockUseTopUp.mockReturnValue({ data });
}

describe('BillingReturnPage — le frontend ne fait que SONDER (jamais confirmer)', () => {
  beforeEach(() => {
    mockGetPending.mockReset();
    mockUseTopUp.mockReset();
    mockClear.mockReset();
  });

  it('aucun paiement en attente → message dédié', () => {
    mockGetPending.mockReturnValue(null);
    setTopUp(undefined);
    render(<BillingReturnPage />);
    expect(screen.queryByTestId('return-none')).not.toBeNull();
  });

  it('statut PENDING → attente (polling en cours)', () => {
    mockGetPending.mockReturnValue('tu1');
    setTopUp({ status: 'PENDING' });
    render(<BillingReturnPage />);
    expect(screen.queryByTestId('return-waiting')).not.toBeNull();
  });

  it('statut PAID → paiement confirmé + crédits ajoutés (tranché par le backend)', () => {
    mockGetPending.mockReturnValue('tu1');
    setTopUp({ status: 'PAID', creditsGranted: 100, bonusCredits: 20 });
    render(<BillingReturnPage />);
    const paid = screen.getByTestId('return-paid');
    expect(paid.textContent).toContain('120'); // 100 + 20
  });

  it('statut REVIEW_REQUIRED → vérification manuelle, jamais crédité côté UI', () => {
    mockGetPending.mockReturnValue('tu1');
    setTopUp({ status: 'REVIEW_REQUIRED' });
    render(<BillingReturnPage />);
    expect(screen.queryByTestId('return-review')).not.toBeNull();
  });

  it('statut FAILED → paiement non abouti', () => {
    mockGetPending.mockReturnValue('tu1');
    setTopUp({ status: 'FAILED' });
    render(<BillingReturnPage />);
    expect(screen.queryByTestId('return-failed')).not.toBeNull();
  });
});
