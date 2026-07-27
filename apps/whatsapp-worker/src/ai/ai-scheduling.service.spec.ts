import type { ConfigService } from '@nestjs/config';
import { aiDebounceJobId } from '@whauto/shared';
import type { Queue } from 'bullmq';

import { AiSchedulingService } from './ai-scheduling.service';

function build(addImpl?: () => Promise<unknown>) {
  const queue = {
    remove: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockImplementation(addImpl ?? (() => Promise.resolve({}))),
  };
  const config = {
    get: (key: string) => ({ AI_DEBOUNCE_MS: 3000 })[key],
  } as unknown as ConfigService;
  return { service: new AiSchedulingService(queue as unknown as Queue, config), queue };
}

const REFS = {
  organizationId: 'org-1',
  shopId: 'shop-1',
  conversationId: 'conv-1',
  triggerMessageId: 'msg-2',
  channelId: 'chan-1',
};

describe('AiSchedulingService — debounce par conversation', () => {
  it('jobId keyé par conversation, séparateur "." (jamais ":") et sans texte client', async () => {
    const { service, queue } = build();
    await service.scheduleDebounced(REFS, 1_000_000);

    const jobId = aiDebounceJobId('conv-1');
    expect(jobId).toBe('ai.debounce.conv-1');
    expect(jobId).not.toContain(':');

    const [, payload, opts] = queue.add.mock.calls[0];
    expect(opts).toMatchObject({ jobId, delay: 3000, removeOnComplete: true, removeOnFail: false });
    // Payload = références uniquement (ajustement 5) : aucun champ de texte.
    expect(Object.keys(payload).sort()).toEqual(
      ['channelId', 'conversationId', 'organizationId', 'scheduledAt', 'shopId', 'triggerMessageId'].sort(),
    );
    expect(JSON.stringify(payload)).not.toMatch(/content|text|prompt|body/i);
  });

  it('remplace le job différé en attente (remove puis add) pour porter le dernier message', async () => {
    const { service, queue } = build();
    await service.scheduleDebounced(REFS, 1_000_000);
    expect(queue.remove).toHaveBeenCalledWith('ai.debounce.conv-1');
    // remove AVANT add (ordre d'invocation natif, sans jest-extended).
    expect(queue.remove.mock.invocationCallOrder[0]).toBeLessThan(
      queue.add.mock.invocationCallOrder[0],
    );
    expect(queue.add.mock.calls[0][1].triggerMessageId).toBe('msg-2');
  });

  it('publication perdue (Redis KO) : non bloquant, renvoie false — reprise par sweep', async () => {
    const { service } = build(() => Promise.reject(new Error('redis down')));
    await expect(service.scheduleDebounced(REFS, 1_000_000)).resolves.toBe(false);
  });
});
