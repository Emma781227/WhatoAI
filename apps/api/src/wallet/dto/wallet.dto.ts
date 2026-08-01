import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

/** Achat de crédits : le frontend n'envoie QUE l'id du pack (montants autoritaires en base). */
export class CreateTopUpDto {
  @IsString()
  @IsNotEmpty()
  creditPackageId!: string;
}

/** Pagination offset commune aux historiques (ledger, consommation, recharges). */
export class WalletPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ── Formes de réponse (mappers dédiés — jamais de secret, jamais l'idempotencyKey) ──

/** Solde Wallet. Les champs comptables (balance/reserved/status) sont OMIS pour
 *  l'AGENT (D7) — masquage CÔTÉ SERVEUR, jamais une simple absence d'affichage. */
export interface WalletResponse {
  availableCredits: number;
  aiAvailable: boolean;
  balanceCredits?: number;
  reservedCredits?: number;
  status?: string;
  version?: number;
}

export interface WalletTransactionResponse {
  id: string;
  type: string;
  direction: string;
  amountCredits: number;
  balanceAfterCredits: number;
  reservedAfterCredits: number;
  referenceType: string | null;
  referenceId: string | null;
  descriptionCode: string | null;
  createdAt: string;
}

export interface AiUsageEventResponse {
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

export interface CreditPackageResponse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
}

export interface TopUpResponse {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
  provider: string;
  createdAt: string;
  paidAt: string | null;
}

export interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
