import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Message } from '../api';
import { MessageBubble } from './message-bubble';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    organizationId: 'org1',
    shopId: 'shop1',
    conversationId: 'conv1',
    channelId: 'chan1',
    contactId: 'contact1',
    clientMessageId: null,
    direction: 'OUTBOUND',
    type: 'TEXT',
    status: 'SENT',
    senderType: 'AGENT',
    senderUserId: null,
    senderUser: null,
    textContent: 'Bonjour',
    mediaUrl: null,
    mediaMimeType: null,
    mediaFileName: null,
    quotedMessageId: null,
    errorCode: null,
    errorMessage: null,
    sentAt: '2026-07-27T10:00:00.000Z',
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('MessageBubble — marquage IA (C5)', () => {
  it('un message OUTBOUND senderType=AI porte le label « Réponse IA » et data-ai-message', () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ senderType: 'AI', textContent: 'Réponse automatique.' })} />,
    );
    expect(screen.getByText('Réponse IA')).toBeInTheDocument();
    expect(container.querySelector('[data-ai-message="true"]')).not.toBeNull();
    expect(screen.getByText('Réponse automatique.')).toBeInTheDocument();
  });

  it('un message OUTBOUND humain (AGENT) n’est PAS marqué IA', () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ senderType: 'AGENT', textContent: 'Réponse humaine.' })} />,
    );
    expect(screen.queryByText('Réponse IA')).toBeNull();
    expect(container.querySelector('[data-ai-message="true"]')).toBeNull();
  });

  it('un message entrant client n’est jamais marqué IA', () => {
    const { container } = render(
      <MessageBubble
        message={makeMessage({ direction: 'INBOUND', senderType: 'CUSTOMER', textContent: 'Bonjour' })}
      />,
    );
    expect(container.querySelector('[data-ai-message="true"]')).toBeNull();
  });
});
