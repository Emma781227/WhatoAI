'use client';

import { Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useWallet } from '@/features/wallet/use-wallet';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { usePermissions } from '@/lib/permissions/use-permissions';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import type { AiSuggestion } from '../api';
import {
  useAcceptSuggestion,
  useAiSuggestions,
  useGenerateSuggestion,
  useRejectSuggestion,
} from '../use-ai-suggestions';

/**
 * Bloc « Suggestion IA » au-dessus du composer. L'IA violette (#7C3AED) le
 * distingue d'une réponse humaine. Règles :
 * - Insérer PRÉREMPLIT le composer, ne l'envoie JAMAIS (l'envoi humain reste le
 *   clic explicite dans le composer) ;
 * - Envoyer accepte la suggestion (contenu ÉDITÉ inclus) via l'endpoint dédié ;
 * - un 409 AI_SUGGESTION_STALE ouvre un avertissement Annuler / Envoyer quand
 *   même (second appel avec confirmStale=true) ;
 * - toute erreur est NON bloquante : la réponse manuelle reste toujours possible.
 */
export function SuggestionPanel({
  conversationId,
  onInsert,
}: {
  conversationId: string;
  onInsert: (text: string) => void;
}) {
  const { can } = usePermissions();
  const canRead = can(PERMISSIONS.AI_READ);
  const canSuggest = can(PERMISSIONS.AI_SUGGEST);
  const canAccept = can(PERMISSIONS.AI_ACCEPT_SUGGESTION);
  const canReject = can(PERMISSIONS.AI_REJECT_SUGGESTION);

  const suggestionsQuery = useAiSuggestions(conversationId, canRead);
  const walletQuery = useWallet();
  // Optimiste : tant que le solde n'est pas chargé, on n'entrave pas (le serveur
  // reste l'autorité — un 409 INSUFFICIENT_CREDITS est géré à la génération).
  const aiAvailable = walletQuery.data?.aiAvailable ?? true;
  const generateMutation = useGenerateSuggestion(conversationId);
  const acceptMutation = useAcceptSuggestion(conversationId);
  const rejectMutation = useRejectSuggestion(conversationId);

  const pending: AiSuggestion | null = useMemo(() => {
    const items = suggestionsQuery.data?.items ?? [];
    return items.find((s) => s.status === 'PENDING') ?? null;
  }, [suggestionsQuery.data]);

  const [draft, setDraft] = useState('');
  const [staleFor, setStaleFor] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [handoff, setHandoff] = useState(false);

  // Le draft suit la suggestion PENDING courante (réinitialisé quand elle change).
  useEffect(() => {
    setDraft(pending?.content ?? '');
    setStaleFor(null);
  }, [pending?.id, pending?.content]);

  // Une suggestion est arrivée → on n'attend plus.
  useEffect(() => {
    if (pending) setAwaiting(false);
  }, [pending]);

  // Changement de conversation : on repart propre (pas d'état d'une autre conv).
  useEffect(() => {
    setAwaiting(false);
    setHandoff(false);
  }, [conversationId]);

  if (!canRead) {
    return null;
  }

  const generating = awaiting || generateMutation.isPending;

  const runGenerate = (force: boolean) => {
    setHandoff(false);
    generateMutation.mutate(force, {
      onSuccess: (result) => {
        if (result.status === 'QUEUED' || result.status === 'RUN_IN_PROGRESS') {
          setAwaiting(true);
        } else if (result.status === 'NO_NEW_RUN') {
          // Le dernier message a déjà été traité : pas de nouvelle suggestion
          // possible sans nouveau message client (invariant run unique).
          setAwaiting(false);
          toast.message('Aucune nouvelle suggestion : le client doit écrire à nouveau.');
        } else {
          setAwaiting(false);
        }
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'AI_CONVERSATION_IN_HANDOFF') {
          setHandoff(true);
          return;
        }
        if (error instanceof ApiError && error.code === 'INSUFFICIENT_CREDITS') {
          toast.error('Crédits IA insuffisants — rechargez pour générer une suggestion.');
          return;
        }
        toast.error(getErrorMessage(error));
      },
    });
  };

  const doAccept = (confirmStale: boolean) => {
    if (!pending) return;
    acceptMutation.mutate(
      { suggestionId: pending.id, content: draft.trim(), expectedVersion: pending.version, confirmStale },
      {
        onSuccess: () => {
          setStaleFor(null);
          toast.success('Réponse envoyée');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'AI_SUGGESTION_STALE') {
            setStaleFor(pending.id);
            return;
          }
          toast.error(getErrorMessage(error));
        },
      },
    );
  };

  const doReject = () => {
    if (!pending) return;
    rejectMutation.mutate(
      { suggestionId: pending.id, expectedVersion: pending.version },
      { onError: (error) => toast.error(getErrorMessage(error)) },
    );
  };

  const busy = acceptMutation.isPending || rejectMutation.isPending;

  return (
    <div
      className="border-t border-border bg-[#7C3AED]/5 px-3 py-2 dark:bg-[#7C3AED]/10"
      data-testid="ai-suggestion-panel"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-[#7C3AED]">
          <Sparkles aria-hidden className="h-3.5 w-3.5" />
          Suggestion IA
        </span>
        {canSuggest && !pending && !generating ? (
          aiAvailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => runGenerate(false)}
              data-testid="ai-generate"
            >
              Générer
            </Button>
          ) : (
            <Link
              href="/billing"
              className="text-xs font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
              data-testid="ai-insufficient-credits"
            >
              Crédits insuffisants — Recharger
            </Link>
          )
        ) : null}
      </div>

      {handoff ? (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="ai-handoff-notice">
          Transfert vers un conseiller humain demandé — l’assistant IA est en pause sur cette
          conversation.
        </p>
      ) : null}

      {generating ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="ai-generating">
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          L’assistant prépare une suggestion…
        </p>
      ) : null}

      {pending ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            maxLength={4096}
            className="min-h-16 resize-none border-[#7C3AED]/30 bg-background text-sm"
            aria-label="Suggestion IA (modifiable)"
            data-testid="ai-suggestion-text"
          />

          {staleFor === pending.id ? (
            <div
              className="rounded-md bg-amber-100 px-2 py-1.5 text-xs dark:bg-amber-950/40"
              data-testid="ai-stale-warning"
            >
              <p className="mb-1 text-amber-800 dark:text-amber-300">
                La conversation a évolué depuis cette suggestion. L’envoyer quand même ?
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setStaleFor(null)}
                  data-testid="ai-stale-cancel"
                >
                  Annuler
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={busy}
                  onClick={() => doAccept(true)}
                  data-testid="ai-stale-confirm"
                >
                  Envoyer quand même
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className={cn('h-7 text-xs')}
                disabled={busy || !canAccept || draft.trim() === ''}
                onClick={() => doAccept(false)}
                data-testid="ai-send"
              >
                Envoyer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onInsert(draft.trim())}
                disabled={draft.trim() === ''}
                data-testid="ai-insert"
              >
                Insérer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={busy || !canReject}
                onClick={doReject}
                data-testid="ai-reject"
              >
                Rejeter
              </Button>
              {canSuggest ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  disabled={busy}
                  onClick={() => runGenerate(true)}
                  data-testid="ai-regenerate"
                >
                  Régénérer
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
