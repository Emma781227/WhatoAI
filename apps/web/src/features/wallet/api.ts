import { apiRequest } from '@/lib/api/client';

/** Solde. Les champs comptables sont ABSENTS pour l'AGENT (masqués côté serveur, D7). */
export interface WalletBalance {
  availableCredits: number;
  aiAvailable: boolean;
  balanceCredits?: number;
  reservedCredits?: number;
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  version?: number;
}

export interface WalletTransaction {
  id: string;
  type: string;
  direction: 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE';
  amountCredits: number;
  balanceAfterCredits: number;
  reservedAfterCredits: number;
  referenceType: string | null;
  referenceId: string | null;
  descriptionCode: string | null;
  createdAt: string;
}

export interface AiUsageEvent {
  id: string;
  aiRunId: string;
  status: string;
  creditsReserved: number;
  creditsCharged: number;
  successfulToolCalls: number;
  reasonCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreditPackage {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
}

export interface TopUp {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  amountMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
  provider: 'MOCK' | 'GENIUS_PAY';
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentSession {
  provider: string;
  providerPaymentId: string;
  reference: string;
  checkoutUrl: string | null;
  status: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}

function query(params: PageQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

export const walletApi = {
  getBalance(org: string) {
    return apiRequest<WalletBalance>(`/organizations/${org}/wallet`);
  },
  listTransactions(org: string, params: PageQuery = {}) {
    return apiRequest<Paged<WalletTransaction>>(
      `/organizations/${org}/wallet/transactions${query(params)}`,
    );
  },
  listUsage(org: string, params: PageQuery = {}) {
    return apiRequest<Paged<AiUsageEvent>>(`/organizations/${org}/wallet/usage${query(params)}`);
  },
  listPackages(org: string) {
    return apiRequest<{ items: CreditPackage[] }>(`/organizations/${org}/wallet/packages`);
  },
  createTopUp(org: string, creditPackageId: string) {
    return apiRequest<{ topUp: TopUp; paymentSession: PaymentSession }>(
      `/organizations/${org}/wallet/top-ups`,
      { method: 'POST', body: { creditPackageId } },
    );
  },
  listTopUps(org: string, params: PageQuery = {}) {
    return apiRequest<Paged<TopUp>>(`/organizations/${org}/wallet/top-ups${query(params)}`);
  },
  mockConfirm(org: string, topUpId: string) {
    return apiRequest<{ topUpId: string; status: string; alreadyPaid: boolean; balanceAfterCredits: number }>(
      `/organizations/${org}/wallet/top-ups/${topUpId}/mock-confirm`,
      { method: 'POST', body: {} },
    );
  },
};

export const walletKeys = {
  all: (org: string) => ['wallet', org] as const,
  balance: (org: string) => ['wallet', org, 'balance'] as const,
  transactions: (org: string, params: PageQuery) => ['wallet', org, 'transactions', params] as const,
  usage: (org: string, params: PageQuery) => ['wallet', org, 'usage', params] as const,
  packages: (org: string) => ['wallet', org, 'packages'] as const,
  topUps: (org: string, params: PageQuery) => ['wallet', org, 'top-ups', params] as const,
};
