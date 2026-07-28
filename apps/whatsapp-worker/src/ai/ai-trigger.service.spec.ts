import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';
import type { WalletReservationService } from '../wallet/wallet-reservation.service';
import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { AiTriggerService, resolveEffectiveAiMode } from './ai-trigger.service';
import type { AiProcessMessageJobData } from '@whauto/shared';

describe('resolveEffectiveAiMode (ordre de priorité, ajustement 2)', () => {
  it('AI_MODE=DISABLED est un coupe-circuit global, même si la Shop veut SUGGEST_ONLY', () => {
    expect(resolveEffectiveAiMode('DISABLED', 'SUGGEST_ONLY')).toBe('DISABLED');
    expect(resolveEffectiveAiMode('DISABLED', 'AUTO_REPLY')).toBe('DISABLED');
    expect(resolveEffectiveAiMode('DISABLED', null)).toBe('DISABLED');
  });

  it('la configuration Shop fait autorité quand elle existe', () => {
    expect(resolveEffectiveAiMode('SUGGEST_ONLY', 'DISABLED')).toBe('DISABLED');
    expect(resolveEffectiveAiMode('SUGGEST_ONLY', 'AUTO_REPLY')).toBe('AUTO_REPLY');
  });

  it('fallback sur AI_MODE (env) quand aucune configuration Shop', () => {
    expect(resolveEffectiveAiMode('SUGGEST_ONLY', null)).toBe('SUGGEST_ONLY');
    expect(resolveEffectiveAiMode('AUTO_REPLY', null)).toBe('AUTO_REPLY');
  });
});

const DATA: AiProcessMessageJobData = {
  organizationId: 'org-1',
  shopId: 'shop-1',
  conversationId: 'conv-1',
  triggerMessageId: 'msg-1',
  channelId: 'chan-1',
  scheduledAt: '2026-07-24T12:00:00.000Z',
};

function eligibleMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    organizationId: 'org-1',
    shopId: 'shop-1',
    conversationId: 'conv-1',
    channelId: 'chan-1',
    direction: 'INBOUND',
    senderType: 'CUSTOMER',
    type: 'TEXT',
    channel: { status: 'CONNECTED' },
    ...overrides,
  };
}

interface Mocks {
  message: { findUnique: jest.Mock };
  aiConfiguration: { findUnique: jest.Mock };
  conversationHandoff: { findFirst: jest.Mock };
  aiRun: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  aiSuggestion: { updateMany: jest.Mock };
  wallet: {
    ensureWalletId: jest.Mock;
    lockAndReadWallet: jest.Mock;
    reserveForRunInTx: jest.Mock;
    releaseRunReservationInTx: jest.Mock;
    recordSkippedForRunInTx: jest.Mock;
  };
  emitter: { emitToOrganization: jest.Mock };
}

function build(
  options: {
    envMode?: string;
    message?: Record<string, unknown> | null;
    config?: { provider: string; mode: string; model: string | null } | null;
    handoff?: { id: string } | null;
    existingRun?: { id: string } | null;
    activeRun?: { id: string } | null;
    walletStatus?: string;
    availableCredits?: number;
  } = {},
) {
  const created: { id: string } = { id: 'run-new' };
  const mocks: Mocks = {
    message: {
      findUnique: jest.fn().mockResolvedValue(
        options.message === undefined ? eligibleMessage() : options.message,
      ),
    },
    aiConfiguration: {
      findUnique: jest.fn().mockResolvedValue(options.config ?? null),
    },
    conversationHandoff: {
      findFirst: jest.fn().mockResolvedValue(options.handoff ?? null),
    },
    aiRun: {
      findUnique: jest.fn().mockResolvedValue(options.existingRun ?? null),
      findFirst: jest.fn().mockResolvedValue(options.activeRun ?? null),
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    aiSuggestion: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    wallet: {
      ensureWalletId: jest.fn().mockResolvedValue('wallet-1'),
      lockAndReadWallet: jest.fn().mockResolvedValue({
        balanceCredits: options.availableCredits ?? 10,
        reservedCredits: 0,
        status: options.walletStatus ?? 'ACTIVE',
        availableCredits: options.availableCredits ?? 10,
      }),
      reserveForRunInTx: jest.fn().mockResolvedValue({
        walletTransactionId: 'wtx-1',
        balanceAfterCredits: 10,
        reservedAfterCredits: 3,
        availableAfterCredits: 7,
        replayed: false,
      }),
      releaseRunReservationInTx: jest.fn().mockResolvedValue({ released: true, walletId: 'wallet-1' }),
      recordSkippedForRunInTx: jest.fn().mockResolvedValue(undefined),
    },
    emitter: { emitToOrganization: jest.fn() },
  };

  const prisma = {
    message: mocks.message,
    aiConfiguration: mocks.aiConfiguration,
    conversationHandoff: mocks.conversationHandoff,
    aiRun: mocks.aiRun,
    aiSuggestion: mocks.aiSuggestion,
    wallet: {
      findUnique: jest.fn().mockResolvedValue({
        balanceCredits: options.availableCredits ?? 10,
        reservedCredits: 3,
        status: options.walletStatus ?? 'ACTIVE',
        version: 1,
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
      cb({
        $queryRaw: jest.fn().mockResolvedValue([]),
        aiRun: mocks.aiRun,
        aiSuggestion: mocks.aiSuggestion,
      }),
    ),
  } as unknown as PrismaService;

  const config = {
    get: (key: string) =>
      ({ AI_MODE: options.envMode ?? 'SUGGEST_ONLY', AI_PROVIDER: 'MOCK' })[key],
  } as unknown as ConfigService;

  const service = new AiTriggerService(
    prisma,
    config,
    mocks.wallet as unknown as WalletReservationService,
    mocks.emitter as unknown as AiRealtimeEmitter,
  );
  return { service, mocks };
}

describe('AiTriggerService.processTrigger — gardes rejouées à l’exécution', () => {
  it('crée un run QUEUED et RÉSERVE pour un message texte éligible', async () => {
    const { service, mocks } = build();
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('RUN_CREATED');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'QUEUED',
          triggerMessageId: 'msg-1',
          contextLastMessageId: 'msg-1',
        }),
      }),
    );
    // Réservation faite pour le run créé + émission balance après commit.
    expect(mocks.wallet.reserveForRunInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ aiRunId: 'run-new', walletId: 'wallet-1' }),
    );
    expect(mocks.emitter.emitToOrganization).toHaveBeenCalledWith(
      'org-1',
      'wallet.balance.updated',
      expect.objectContaining({ walletId: 'wallet-1', aiAvailable: expect.any(Boolean) }),
    );
  });

  it('coupe-circuit global : AI_MODE=DISABLED → aucun run, aucune lecture message, aucune réservation', async () => {
    const { service, mocks } = build({ envMode: 'DISABLED' });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_GLOBAL_DISABLED');
    expect(mocks.message.findUnique).not.toHaveBeenCalled();
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
    expect(mocks.wallet.ensureWalletId).not.toHaveBeenCalled();
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
  });

  it('Shop en DISABLED (config) l’emporte sur AI_MODE actif → aucun run, aucune réservation', async () => {
    const { service, mocks } = build({
      config: { provider: 'MOCK', mode: 'DISABLED', model: 'mock-model' },
    });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_SHOP_DISABLED');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
  });

  it('média (type non texte) → jamais de run ni de réservation', async () => {
    const { service, mocks } = build({ message: eligibleMessage({ type: 'IMAGE' }) });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED_TYPE');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
  });

  it('message d’une autre Shop/Conversation (incohérence) → refus tenant', async () => {
    const { service } = build({ message: eligibleMessage({ shopId: 'autre-shop' }) });
    expect((await service.processTrigger(DATA)).outcome).toBe('SKIPPED_TENANT_MISMATCH');
  });

  it('canal non connecté → aucun run', async () => {
    const { service } = build({ message: eligibleMessage({ channel: { status: 'DISCONNECTED' } }) });
    expect((await service.processTrigger(DATA)).outcome).toBe('SKIPPED_CHANNEL_NOT_CONNECTED');
  });

  it('message disparu → skip propre', async () => {
    const { service } = build({ message: null });
    expect((await service.processTrigger(DATA)).outcome).toBe('SKIPPED_MESSAGE_GONE');
  });

  it('handoff ouvert → run SKIPPED tracé, jamais de génération ni de réservation', async () => {
    const { service, mocks } = build({ handoff: { id: 'handoff-1' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('HANDOFF_SKIPPED');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'AI_BLOCKED_BY_HANDOFF' }),
      }),
    );
    expect(mocks.aiRun.findFirst).not.toHaveBeenCalled();
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
  });

  it('run déjà existant pour le déclencheur → ALREADY_RUN, aucune réservation (idempotent)', async () => {
    const { service, mocks } = build({ existingRun: { id: 'run-existant' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('ALREADY_RUN');
    expect(result.runId).toBe('run-existant');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
    expect(mocks.emitter.emitToOrganization).not.toHaveBeenCalled();
  });

  it('run actif d’un déclencheur antérieur → supersede + libération + création réservée', async () => {
    const { service, mocks } = build({ activeRun: { id: 'run-vieux' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SUPERSEDED_AND_CREATED');
    expect(result.supersededRunId).toBe('run-vieux');
    // La réservation du run superseded est libérée AVANT réservation du nouveau.
    expect(mocks.wallet.releaseRunReservationInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ aiRunId: 'run-vieux' }),
    );
    // L'ancien run quitte l'ensemble ACTIF (SUPERSEDED) via updateMany
    // conditionnel AVANT création du nouveau, puis reçoit supersededByRunId.
    expect(mocks.aiRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'run-vieux' }),
        data: expect.objectContaining({ status: 'SUPERSEDED' }),
      }),
    );
    expect(mocks.aiRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-vieux' },
        data: expect.objectContaining({ supersededByRunId: 'run-new' }),
      }),
    );
    expect(mocks.aiSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
    expect(mocks.wallet.reserveForRunInTx).toHaveBeenCalled();
  });

  it('solde insuffisant → run SKIPPED (INSUFFICIENT_CREDITS), aucune réservation, wallet.insufficient émis', async () => {
    const { service, mocks } = build({ availableCredits: 2 });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_INSUFFICIENT_CREDITS');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'INSUFFICIENT_CREDITS' }),
      }),
    );
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
    expect(mocks.wallet.recordSkippedForRunInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reasonCode: 'INSUFFICIENT_CREDITS' }),
    );
    expect(mocks.emitter.emitToOrganization).toHaveBeenCalledWith(
      'org-1',
      'wallet.insufficient',
      expect.objectContaining({ requiredCredits: 3 }),
    );
  });

  it('Wallet SUSPENDED → run SKIPPED (WALLET_SUSPENDED), aucune réservation, aucun wallet.insufficient', async () => {
    const { service, mocks } = build({ walletStatus: 'SUSPENDED' });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_WALLET_SUSPENDED');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'WALLET_SUSPENDED' }),
      }),
    );
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
    expect(mocks.emitter.emitToOrganization).not.toHaveBeenCalled();
  });

  it('Wallet CLOSED → run SKIPPED (WALLET_CLOSED), aucune réservation', async () => {
    const { service, mocks } = build({ walletStatus: 'CLOSED' });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_WALLET_CLOSED');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'WALLET_CLOSED' }),
      }),
    );
    expect(mocks.wallet.reserveForRunInTx).not.toHaveBeenCalled();
  });

  it('modèle absent pour un provider GEMINI → SKIPPED_MISCONFIGURED (jamais de modèle deviné)', async () => {
    const { service } = build({
      config: { provider: 'GEMINI', mode: 'SUGGEST_ONLY', model: null },
    });
    expect((await service.processTrigger(DATA)).outcome).toBe('SKIPPED_MISCONFIGURED');
  });
});
