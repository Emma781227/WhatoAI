'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pause, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { aiSuggestionsApi } from '@/features/ai-suggestions/api';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';
import { cn } from '@/lib/utils';

import { conversationKeys } from '../api';

/**
 * Contrôle d'auto-réponse IA dans l'en-tête d'une conversation (sous-phase C).
 * N'est rendu QUE lorsque la Shop est en AUTO_REPLY activé. Badge violet #7C3AED
 * (couleur IA réservée) + bascule pause/reprise (permission conversations.reply).
 * Le badge reflète `aiAutoReplyPaused` ; la reprise humaine (réponse manuelle)
 * met déjà la conversation en pause côté serveur.
 */
export function AutoReplyControl({
  organizationId,
  conversationId,
  paused,
}: {
  organizationId: string;
  conversationId: string;
  paused: boolean;
}) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canToggle = can(PERMISSIONS.CONVERSATIONS_REPLY);

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: conversationKeys.detail(organizationId, conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: [...conversationKeys.all(organizationId), 'list'],
    });
  };

  const pauseMutation = useMutation({
    mutationFn: () => aiSuggestionsApi.pauseAutoReply(organizationId, conversationId),
    onSuccess: invalidate,
    onError: (error) => toast.error(getErrorMessage(error)),
  });
  const resumeMutation = useMutation({
    mutationFn: () => aiSuggestionsApi.resumeAutoReply(organizationId, conversationId),
    onSuccess: invalidate,
    onError: (error) => toast.error(getErrorMessage(error)),
  });
  const busy = pauseMutation.isPending || resumeMutation.isPending;

  return (
    <div className="flex items-center gap-2" data-testid="auto-reply-control">
      <span
        className={cn(
          'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
          paused ? 'bg-muted text-muted-foreground' : 'bg-[#7C3AED]/10 text-[#7C3AED]',
        )}
        data-testid="auto-reply-badge"
        data-paused={paused}
      >
        <Sparkles aria-hidden className="h-3 w-3" />
        {paused ? 'IA en pause' : 'L’IA répond automatiquement'}
      </span>
      {canToggle ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={busy}
          onClick={() => (paused ? resumeMutation : pauseMutation).mutate()}
          data-testid={paused ? 'auto-reply-resume' : 'auto-reply-pause'}
        >
          {busy ? (
            <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
          ) : paused ? (
            <Play aria-hidden className="h-3 w-3" />
          ) : (
            <Pause aria-hidden className="h-3 w-3" />
          )}
          {paused ? 'Reprendre' : 'Pause'}
        </Button>
      ) : null}
    </div>
  );
}
