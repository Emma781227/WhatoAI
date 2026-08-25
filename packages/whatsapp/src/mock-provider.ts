import { randomUUID } from 'node:crypto';

import type { WhatsAppProvider } from './provider.interface';
import type {
  InboundDeliveryStatus,
  MarkMessageAsReadInput,
  NormalizedInboundEvent,
  RawInboundEvent,
  SendMessageResult,
  SendTextMessageInput,
  WhatsAppProviderName,
} from './types';
import { WhatsAppProviderSendError } from './types';

/**
 * Un texte sortant commençant par ce préfixe fait échouer l'envoi mock avec
 * un code déterministe — permet de tester le chemin FAILED sans hasard.
 */
export const MOCK_FAIL_TRIGGER = '!fail';

export const MOCK_SIMULATED_FAILURE_CODE = 'MOCK_SIMULATED_FAILURE';

export function generateMockWamid(): string {
  return `wamid.mock.${randomUUID()}`;
}

/** Corps brut d'un webhook mock — ce que POST /api/dev/whatsapp/mock/* construit. */
export interface MockInboundMessageBody {
  mock: true;
  kind: 'message';
  externalEventId: string;
  externalMessageId: string;
  from: string;
  displayName?: string;
  /** Corps du message, ou LÉGENDE quand un média est simulé. */
  text: string;
  timestamp: string;
  /**
   * Média SIMULÉ (explicitement factice, comme tout ce provider) : permet
   * d'exercer la chaîne d'ingestion média sans dépendre de Meta. Le
   * téléchargement, lui, reste piloté par le stockage mock côté worker.
   */
  media?: {
    type: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER';
    externalMediaId: string;
    mimeType?: string;
    fileName?: string;
    sizeBytes?: number;
    sha256?: string;
    voice?: boolean;
  };
}

export interface MockInboundStatusBody {
  mock: true;
  kind: 'status';
  externalEventId: string;
  externalMessageId: string;
  status: InboundDeliveryStatus;
  timestamp: string;
  errorCode?: string;
  errorMessage?: string;
}

export type MockInboundBody = MockInboundMessageBody | MockInboundStatusBody;

export interface MockWhatsAppProviderOptions {
  /** Latence simulée de l'appel d'envoi (0 par défaut). */
  sendLatencyMs?: number;
  /** Délai simulé avant l'événement DELIVERED d'un message envoyé. */
  deliveryDelayMs?: number;
  /** Délai simulé entre DELIVERED et READ. */
  readDelayMs?: number;
}

interface SimulatedStatusStep {
  status: InboundDeliveryStatus;
  delayMs: number;
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  private readonly sendLatencyMs: number;
  private readonly deliveryDelayMs: number;
  private readonly readDelayMs: number;

  constructor(options: MockWhatsAppProviderOptions = {}) {
    this.sendLatencyMs = options.sendLatencyMs ?? 0;
    this.deliveryDelayMs = options.deliveryDelayMs ?? 1500;
    this.readDelayMs = options.readDelayMs ?? 2000;
  }

  getProviderName(): WhatsAppProviderName {
    return 'MOCK';
  }

  validateInboundEvent(event: RawInboundEvent): boolean {
    const body = event.body as { mock?: unknown } | null | undefined;
    return typeof body === 'object' && body !== null && body.mock === true;
  }

  parseInboundEvent(event: RawInboundEvent): NormalizedInboundEvent[] {
    if (!this.validateInboundEvent(event)) {
      throw new WhatsAppProviderSendError('Invalid mock inbound event.', 'MOCK_INVALID_EVENT');
    }
    const body = event.body as Partial<MockInboundBody>;

    if (body.kind === 'message') {
      if (!body.externalEventId || !body.externalMessageId || !body.from || !body.text || !body.timestamp) {
        throw new WhatsAppProviderSendError(
          'Mock message event is missing required fields.',
          'MOCK_INVALID_EVENT',
        );
      }
      return [
        {
          kind: 'message',
          externalEventId: body.externalEventId,
          externalMessageId: body.externalMessageId,
          from: body.from,
          displayName: body.displayName,
          // Texte par défaut ; un média simulé impose son type et garde le
          // texte fourni comme LÉGENDE (même sémantique que Meta).
          messageType: body.media?.type ?? 'TEXT',
          text: body.text,
          media: body.media
            ? {
                externalMediaId: body.media.externalMediaId,
                mimeType: body.media.mimeType ?? null,
                fileName: body.media.fileName ?? null,
                sizeBytes: body.media.sizeBytes ?? null,
                sha256: body.media.sha256 ?? null,
                voice: body.media.voice === true,
              }
            : null,
          providerTimestamp: body.timestamp,
        },
      ];
    }

    if (body.kind === 'status') {
      if (!body.externalEventId || !body.externalMessageId || !body.status || !body.timestamp) {
        throw new WhatsAppProviderSendError(
          'Mock status event is missing required fields.',
          'MOCK_INVALID_EVENT',
        );
      }
      return [
        {
          kind: 'status',
          externalEventId: body.externalEventId,
          externalMessageId: body.externalMessageId,
          status: body.status,
          providerTimestamp: body.timestamp,
          errorCode: body.errorCode,
          errorMessage: body.errorMessage,
        },
      ];
    }

    throw new WhatsAppProviderSendError('Unknown mock event kind.', 'MOCK_INVALID_EVENT');
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<SendMessageResult> {
    if (this.sendLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendLatencyMs));
    }
    if (input.text.trimStart().startsWith(MOCK_FAIL_TRIGGER)) {
      throw new WhatsAppProviderSendError(
        'Simulated provider failure (mock trigger).',
        MOCK_SIMULATED_FAILURE_CODE,
      );
    }
    return { externalMessageId: generateMockWamid() };
  }

  async markMessageAsRead(_input: MarkMessageAsReadInput): Promise<void> {
    // Aucune API externe : le mock accepte silencieusement.
  }

  /**
   * Plan de simulation des statuts après un envoi réussi : le worker
   * programme un job différé par étape (DELIVERED puis READ). Un message
   * `!fail` n'atteint jamais ce plan (l'envoi lui-même échoue).
   */
  simulatedStatusPlan(): SimulatedStatusStep[] {
    return [
      { status: 'DELIVERED', delayMs: this.deliveryDelayMs },
      { status: 'READ', delayMs: this.deliveryDelayMs + this.readDelayMs },
    ];
  }
}
