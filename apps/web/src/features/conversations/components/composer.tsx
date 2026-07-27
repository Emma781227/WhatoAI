'use client';

import { Send, StickyNote } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type ComposerMode = 'reply' | 'note';

/**
 * Composer du fil : réponse texte ou note interne (bascule explicite —
 * l'état "note" est visuellement inconfondable avec une réponse client).
 */
export function Composer({
  onSendReply,
  onAddNote,
  canReply,
  canAddNote,
  replyDisabledReason,
  isSending,
  insertText,
}: {
  onSendReply: (text: string) => void;
  onAddNote: (text: string) => void;
  canReply: boolean;
  canAddNote: boolean;
  /** Affiché quand la réponse est impossible (fenêtre 24 h, conversation close…). */
  replyDisabledReason?: string;
  isSending: boolean;
  /**
   * Insertion externe (sélecteur produit) : PRÉREMPLIT le composer uniquement —
   * l'envoi reste le clic explicite de l'agent, jamais automatique.
   */
  insertText?: { value: string; nonce: number } | null;
}) {
  const [mode, setMode] = useState<ComposerMode>('reply');
  const [text, setText] = useState('');

  useEffect(() => {
    if (insertText && insertText.value !== '') {
      setMode('reply');
      setText((current) => (current.trim() === '' ? insertText.value : `${current}\n${insertText.value}`));
    }
    // Déclenché par le nonce : chaque insertion est appliquée une seule fois.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertText?.nonce]);

  const effectiveMode: ComposerMode = mode === 'note' && canAddNote ? 'note' : 'reply';
  const submitDisabled =
    text.trim() === '' || isSending || (effectiveMode === 'reply' && !canReply);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === '' || submitDisabled) {
      return;
    }
    if (effectiveMode === 'note') {
      onAddNote(trimmed);
    } else {
      onSendReply(trimmed);
    }
    setText('');
  };

  return (
    <div
      className={cn(
        'border-t border-border p-3',
        effectiveMode === 'note' && 'bg-amber-50 dark:bg-amber-950/30',
      )}
    >
      {effectiveMode === 'reply' && !canReply && replyDisabledReason ? (
        <p className="mb-2 text-xs text-muted-foreground">{replyDisabledReason}</p>
      ) : null}
      <div className="flex items-end gap-2">
        {canAddNote ? (
          <Button
            type="button"
            variant={effectiveMode === 'note' ? 'default' : 'outline'}
            size="icon"
            className="shrink-0"
            onClick={() => setMode(effectiveMode === 'note' ? 'reply' : 'note')}
            aria-pressed={effectiveMode === 'note'}
            aria-label={
              effectiveMode === 'note' ? 'Repasser en réponse client' : 'Écrire une note interne'
            }
            title={effectiveMode === 'note' ? 'Repasser en réponse client' : 'Écrire une note interne'}
          >
            <StickyNote aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          maxLength={4096}
          placeholder={
            effectiveMode === 'note'
              ? 'Note interne (jamais envoyée au client)…'
              : 'Écrire une réponse…'
          }
          className="max-h-32 min-h-10 flex-1 resize-none"
          aria-label={effectiveMode === 'note' ? 'Note interne' : 'Réponse'}
          data-testid="composer-input"
        />
        <Button
          type="button"
          size="icon"
          className="shrink-0"
          onClick={submit}
          disabled={submitDisabled}
          aria-label={effectiveMode === 'note' ? 'Ajouter la note' : 'Envoyer'}
          data-testid="composer-send"
        >
          <Send aria-hidden className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
