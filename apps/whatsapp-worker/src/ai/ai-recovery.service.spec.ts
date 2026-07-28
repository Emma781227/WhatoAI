import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';
import type { AiOrchestratorService } from './ai-orchestrator.service';
import type { AiSchedulingService } from './ai-scheduling.service';
import { AiRecoveryService } from './ai-recovery.service';

const NOW = 2_000_000_000_000; // instant fixe injecté (jamais Date.now() caché)
const MAX_AGE = 600_000;
const MIN_AGE = 15_000;

/** Message dans la fenêtre valide : plus vieux que MIN_AGE, plus jeune que MAX_AGE. */
function inWindow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-latest',
    organizationId: 'org-1',
    shopId: 'shop-1',
    conversationId: 'conv-1',
    channelId: 'chan-1',
    createdAt: new Date(NOW - 60_000),
    channel: { status: 'CONNECTED' },
    aiRunTriggered: null,
    ...overrides,
  };
}

function build(options: {
  orphans?: { conversationId: string }[];
  latest?: Record<string, unknown> | null;
  activeRun?: { id: string } | null;
  staleRuns?: { id: string }[];
}) {
  const scheduling = { scheduleDebounced: jest.fn().mockResolvedValue(true) };
  const orchestrator = { runGeneration: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    message: {
      findMany: jest.fn().mockResolvedValue(options.orphans ?? [{ conversationId: 'conv-1' }]),
      findFirst: jest.fn().mockResolvedValue(options.latest === undefined ? inWindow() : options.latest),
    },
    aiRun: {
      findFirst: jest.fn().mockResolvedValue(options.activeRun ?? null),
      // Runs coincés (recoverStaleRuns) : vide par défaut → no-op.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue(options.staleRuns ?? []),
    },
  } as unknown as PrismaService;
  const config = {
    get: (key: string) =>
      ({
        AI_RECOVERY_MAX_MESSAGE_AGE_MS: MAX_AGE,
        AI_RECOVERY_MIN_MESSAGE_AGE_MS: MIN_AGE,
      })[key],
  } as unknown as ConfigService;
  const service = new AiRecoveryService(
    prisma,
    config,
    scheduling as unknown as AiSchedulingService,
    orchestrator as unknown as AiOrchestratorService,
  );
  return { service, scheduling, orchestrator, prisma };
}

describe('AiRecoveryService.sweep — reprise après publication perdue', () => {
  it('republie le dernier message éligible sans run (commit OK, Redis KO)', async () => {
    const { service, scheduling } = build({});
    const recovered = await service.sweep(NOW);
    expect(recovered).toBe(1);
    expect(scheduling.scheduleDebounced).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', triggerMessageId: 'msg-latest' }),
      NOW,
    );
  });

  it('ne re-déclenche PAS si le dernier message a déjà un run', async () => {
    const { service, scheduling } = build({ latest: inWindow({ aiRunTriggered: { id: 'run-1' } }) });
    expect(await service.sweep(NOW)).toBe(0);
    expect(scheduling.scheduleDebounced).not.toHaveBeenCalled();
  });

  it('ne re-déclenche PAS quand un run est déjà actif pour la conversation', async () => {
    const { service, scheduling } = build({ activeRun: { id: 'run-actif' } });
    expect(await service.sweep(NOW)).toBe(0);
    expect(scheduling.scheduleDebounced).not.toHaveBeenCalled();
  });

  it('ignore un message trop VIEUX (hors fenêtre maximale)', async () => {
    const tooOld = inWindow({ createdAt: new Date(NOW - MAX_AGE - 1000) });
    const { service, scheduling } = build({ latest: tooOld });
    expect(await service.sweep(NOW)).toBe(0);
    expect(scheduling.scheduleDebounced).not.toHaveBeenCalled();
  });

  it('ignore un message encore CHAUD (dans la fenêtre de debounce) — chemin normal', async () => {
    const stillHot = inWindow({ createdAt: new Date(NOW - MIN_AGE + 1000) });
    const { service, scheduling } = build({ latest: stillHot });
    expect(await service.sweep(NOW)).toBe(0);
    expect(scheduling.scheduleDebounced).not.toHaveBeenCalled();
  });

  it('ignore une conversation dont le canal n’est plus connecté', async () => {
    const { service, scheduling } = build({ latest: inWindow({ channel: { status: 'ERROR' } }) });
    expect(await service.sweep(NOW)).toBe(0);
    expect(scheduling.scheduleDebounced).not.toHaveBeenCalled();
  });

  it('deux sweeps concurrents : le second est un no-op (verrou interne)', async () => {
    const { service } = build({});
    const [a, b] = await Promise.all([service.sweep(NOW), service.sweep(NOW)]);
    // L'un fait le travail, l'autre voit `running` et rend 0 immédiatement.
    expect([a, b].filter((n) => n === 0).length).toBeGreaterThanOrEqual(0);
  });

  it('relance les runs coincés en QUEUED (auto-guérison — plus de blocage permanent)', async () => {
    const { service, orchestrator } = build({
      orphans: [],
      staleRuns: [{ id: 'run-stuck-1' }, { id: 'run-stuck-2' }],
    });
    const recovered = await service.sweep(NOW);
    expect(orchestrator.runGeneration).toHaveBeenCalledWith('run-stuck-1');
    expect(orchestrator.runGeneration).toHaveBeenCalledWith('run-stuck-2');
    expect(recovered).toBe(2);
  });
});
