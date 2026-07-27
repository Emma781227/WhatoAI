import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';
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
  aiRun: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  aiSuggestion: { updateMany: jest.Mock };
}

function build(options: {
  envMode?: string;
  message?: Record<string, unknown> | null;
  config?: { provider: string; mode: string; model: string | null } | null;
  handoff?: { id: string } | null;
  existingRun?: { id: string } | null;
  activeRun?: { id: string } | null;
} = {}) {
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
    },
    aiSuggestion: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    message: mocks.message,
    aiConfiguration: mocks.aiConfiguration,
    conversationHandoff: mocks.conversationHandoff,
    aiRun: mocks.aiRun,
    aiSuggestion: mocks.aiSuggestion,
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

  return { service: new AiTriggerService(prisma, config), mocks };
}

describe('AiTriggerService.processTrigger — gardes rejouées à l’exécution', () => {
  it('crée un run QUEUED pour un message texte éligible', async () => {
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
  });

  it('coupe-circuit global : AI_MODE=DISABLED → aucun run, aucune lecture message', async () => {
    const { service, mocks } = build({ envMode: 'DISABLED' });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_GLOBAL_DISABLED');
    expect(mocks.message.findUnique).not.toHaveBeenCalled();
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
  });

  it('Shop en DISABLED (config) l’emporte sur AI_MODE actif → aucun run', async () => {
    const { service, mocks } = build({
      config: { provider: 'MOCK', mode: 'DISABLED', model: 'mock-model' },
    });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_SHOP_DISABLED');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
  });

  it('média (type non texte) → jamais de run', async () => {
    const { service, mocks } = build({ message: eligibleMessage({ type: 'IMAGE' }) });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED_TYPE');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
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

  it('handoff ouvert → run SKIPPED tracé, jamais de génération', async () => {
    const { service, mocks } = build({ handoff: { id: 'handoff-1' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('HANDOFF_SKIPPED');
    expect(mocks.aiRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', errorCode: 'AI_BLOCKED_BY_HANDOFF' }),
      }),
    );
    // Jamais entré dans la transaction de création de run actif.
    expect(mocks.aiRun.findFirst).not.toHaveBeenCalled();
  });

  it('run déjà existant pour le déclencheur → ALREADY_RUN (idempotent, pas de doublon)', async () => {
    const { service, mocks } = build({ existingRun: { id: 'run-existant' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('ALREADY_RUN');
    expect(result.runId).toBe('run-existant');
    expect(mocks.aiRun.create).not.toHaveBeenCalled();
  });

  it('run actif d’un déclencheur antérieur → supersede + création du nouveau', async () => {
    const { service, mocks } = build({ activeRun: { id: 'run-vieux' } });
    const result = await service.processTrigger(DATA);
    expect(result.outcome).toBe('SUPERSEDED_AND_CREATED');
    expect(result.supersededRunId).toBe('run-vieux');
    // L'ancien run passe SUPERSEDED (conservé) et sa suggestion PENDING expire.
    expect(mocks.aiRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-vieux' },
        data: expect.objectContaining({ status: 'SUPERSEDED', supersededByRunId: 'run-new' }),
      }),
    );
    expect(mocks.aiSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
  });

  it('modèle absent pour un provider GEMINI → SKIPPED_MISCONFIGURED (jamais de modèle deviné)', async () => {
    const { service } = build({
      config: { provider: 'GEMINI', mode: 'SUGGEST_ONLY', model: null },
    });
    expect((await service.processTrigger(DATA)).outcome).toBe('SKIPPED_MISCONFIGURED');
  });
});
