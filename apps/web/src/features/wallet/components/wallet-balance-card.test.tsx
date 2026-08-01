import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WalletBalanceCard } from './wallet-balance-card';

const mockUseWallet = vi.fn();
vi.mock('../use-wallet', () => ({ useWallet: () => mockUseWallet() }));

function setWallet(data: unknown) {
  mockUseWallet.mockReturnValue({ data, isPending: false, isError: false });
}

describe('WalletBalanceCard — forme selon rôle (D7)', () => {
  it('AGENT : disponible + aiAvailable, JAMAIS le détail comptable', () => {
    setWallet({ availableCredits: 5, aiAvailable: true });
    render(<WalletBalanceCard />);

    expect(screen.getByTestId('wallet-available').textContent).toContain('5');
    expect(screen.queryByTestId('ai-available')).not.toBeNull();
    // Champs comptables absents de la réponse → jamais rendus.
    expect(screen.queryByTestId('wallet-ledger-detail')).toBeNull();
  });

  it('solde insuffisant (aiAvailable=false) → avertissement de recharge', () => {
    setWallet({ availableCredits: 1, aiAvailable: false });
    render(<WalletBalanceCard />);

    expect(screen.queryByTestId('ai-unavailable')).not.toBeNull();
    expect(screen.queryByTestId('ai-available')).toBeNull();
  });

  it('rôle comptable : détail balance/reserved/status rendu', () => {
    setWallet({
      availableCredits: 5,
      aiAvailable: true,
      balanceCredits: 8,
      reservedCredits: 3,
      status: 'ACTIVE',
      version: 2,
    });
    render(<WalletBalanceCard />);

    const detail = screen.getByTestId('wallet-ledger-detail');
    expect(detail.textContent).toContain('8');
    expect(detail.textContent).toContain('ACTIVE');
  });
});
