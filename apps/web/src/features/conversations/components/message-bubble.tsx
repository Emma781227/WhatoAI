'use client';

import { AlertCircle, Check, CheckCheck, Clock, Paperclip, RotateCcw, StickyNote } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { Message } from '../api';
import { messageTime } from '../format';

const MEDIA_LABELS: Record<string, string> = {
  IMAGE: 'Le client a envoyé une image',
  AUDIO: 'Le client a envoyé un message vocal',
  VIDEO: 'Le client a envoyé une vidéo',
  DOCUMENT: 'Le client a envoyé un document',
  LOCATION: 'Le client a partagé une position',
  CONTACT: 'Le client a partagé un contact',
  STICKER: 'Le client a envoyé un sticker',
};

/** Libellé lisible d'un média non pris en charge dans cette phase. */
function unsupportedMediaLabel(type: string): string {
  return `${MEDIA_LABELS[type] ?? 'Contenu non pris en charge'} — non pris en charge dans cette version.`;
}

/** Ticks façon WhatsApp : horloge (en cours), ✓ envoyé, ✓✓ distribué, ✓✓ bleu lu. */
function StatusTicks({ message }: { message: Message }) {
  switch (message.status) {
    case 'PENDING':
    case 'QUEUED':
      return <Clock aria-label="En cours d’envoi" className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'SENT':
      return <Check aria-label="Envoyé" className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'DELIVERED':
      return <CheckCheck aria-label="Distribué" className="h-3.5 w-3.5 text-muted-foreground" />;
    case 'READ':
      return <CheckCheck aria-label="Lu" className="h-3.5 w-3.5 text-sky-500" />;
    case 'FAILED':
      return <AlertCircle aria-label="Échec d’envoi" className="h-3.5 w-3.5 text-destructive" />;
    default:
      return null;
  }
}

export function MessageBubble({
  message,
  onRetry,
  onResend,
}: {
  message: Message;
  /** Retry d'un FAILED persisté serveur (endpoint dédié). */
  onRetry?: (messageId: string) => void;
  /** Renvoi d'un optimiste jamais accepté par le serveur (même clientMessageId). */
  onResend?: (message: Message) => void;
}) {
  // Note interne : visuellement inconfondable avec un message client.
  if (message.type === 'INTERNAL_NOTE') {
    return (
      <div className="flex justify-center" data-testid="internal-note">
        <div className="max-w-[85%] rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="mb-0.5 flex items-center gap-1 text-xs font-medium">
            <StickyNote aria-hidden className="h-3 w-3" />
            Note interne
            {message.senderUser
              ? ` — ${message.senderUser.firstName} ${message.senderUser.lastName}`
              : ''}
          </span>
          <p className="whitespace-pre-wrap break-words">{message.textContent}</p>
          <span className="mt-0.5 block text-right text-[10px] opacity-70">
            {messageTime(message.createdAt)}
          </span>
        </div>
      </div>
    );
  }

  const isOutbound = message.direction === 'OUTBOUND';
  const isLocalOptimisticFailure =
    message.status === 'FAILED' && message.id.startsWith('optimistic:');

  return (
    <div className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%]',
          isOutbound
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm border border-border bg-card text-foreground',
        )}
        data-testid={isOutbound ? 'message-outbound' : 'message-inbound'}
        data-message-status={message.status}
      >
        {message.textContent ? (
          <p className="whitespace-pre-wrap break-words">{message.textContent}</p>
        ) : (
          // Médias non pris en charge dans cette phase : le vrai type est
          // conservé côté serveur ; l'UI génère un libellé lisible.
          <p className="flex items-center gap-1.5 italic opacity-80" data-testid="message-unsupported">
            <Paperclip aria-hidden className="h-3.5 w-3.5" />
            {unsupportedMediaLabel(message.type)}
          </p>
        )}
        <span
          className={cn(
            'mt-1 flex items-center justify-end gap-1 text-[10px]',
            isOutbound ? 'text-primary-foreground/80' : 'text-muted-foreground',
          )}
        >
          {messageTime(message.createdAt)}
          {isOutbound ? <StatusTicks message={message} /> : null}
        </span>
        {message.status === 'FAILED' ? (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-black/10 px-2 py-1 text-xs">
            <span className="truncate">
              {message.errorCode === 'CUSTOMER_SERVICE_WINDOW_EXPIRED'
                ? 'Fenêtre de 24 h expirée'
                : 'L’envoi a échoué'}
            </span>
            {isLocalOptimisticFailure && onResend ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-xs"
                onClick={() => onResend(message)}
              >
                <RotateCcw aria-hidden className="h-3 w-3" />
                Renvoyer
              </Button>
            ) : !isLocalOptimisticFailure && onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-xs"
                onClick={() => onRetry(message.id)}
              >
                <RotateCcw aria-hidden className="h-3 w-3" />
                Réessayer
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
