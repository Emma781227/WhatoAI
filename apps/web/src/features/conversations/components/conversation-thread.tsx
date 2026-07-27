'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Info, Loader2, PackagePlus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/error-state';
import { memberKeys, membershipsApi } from '@/features/memberships/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { ProductPickerDialog } from '@/features/products/components/product-picker-dialog';
import { SuggestionPanel } from '@/features/ai-suggestions/components/suggestion-panel';
import { useComposerInsert } from '../composer-insert';
import { useRetryMessage, useSendMessage } from '@/features/messages/use-conversation-messages';
import { useConversationMessages } from '@/features/messages/use-conversation-messages';
import { getErrorMessage } from '@/lib/api/api-error';
import { usePermissions } from '@/lib/permissions/use-permissions';
import { PERMISSIONS } from '@/lib/permissions/constants';

import { conversationKeys, conversationsApi, type ConversationStatus, type Message } from '../api';
import {
  CONVERSATION_STATUS_LABELS,
  contactInitials,
  contactLabel,
  dayLabel,
} from '../format';
import { useConversation } from '../use-conversations';
import { Composer } from './composer';
import { MessageBubble } from './message-bubble';

const NEXT_STATUSES: Record<ConversationStatus, ConversationStatus[]> = {
  OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
  PENDING: ['OPEN', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

function groupByDay(messages: Message[]): Array<{ day: string; items: Message[] }> {
  const groups: Array<{ day: string; items: Message[] }> = [];
  for (const message of messages) {
    const day = new Date(message.createdAt).toDateString();
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.items.push(message);
    } else {
      groups.push({ day, items: [message] });
    }
  }
  return groups;
}

export function ConversationThread({
  conversationId,
  onBack,
  onToggleContactPanel,
}: {
  conversationId: string;
  onBack: () => void;
  onToggleContactPanel: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { can } = usePermissions();

  const conversationQuery = useConversation(conversationId);
  const conversation = conversationQuery.data ?? null;
  const messagesQuery = useConversationMessages(conversationId);
  const sendMutation = useSendMessage(conversation);
  const retryMutation = useRetryMessage(conversationId);

  // Sélecteur produit : le résumé revalidé préremplit le composer (contexte
  // partagé — le panneau Panier utilise le même canal pour son résumé).
  const [pickerOpen, setPickerOpen] = useState(false);
  const { insertText, insert } = useComposerInsert();

  const membersQuery = useQuery({
    queryKey: memberKeys.list(organizationId, 1),
    queryFn: () => membershipsApi.list(organizationId, { limit: 100 }),
    enabled: can(PERMISSIONS.CONVERSATIONS_ASSIGN),
  });

  // Ordre d'affichage ascendant (l'API renvoie les plus récents d'abord).
  const messages = useMemo(() => {
    const items = messagesQuery.data?.pages.flatMap((page) => page.items) ?? [];
    return [...items].reverse();
  }, [messagesQuery.data]);

  // Marquage lu à l'ouverture et à chaque nouveau message entrant affiché.
  const markReadMutation = useMutation({
    mutationFn: () => conversationsApi.markRead(organizationId, conversationId),
    onSuccess: (updated) => {
      queryClient.setQueryData(conversationKeys.detail(organizationId, conversationId), updated);
      void queryClient.invalidateQueries({
        queryKey: [...conversationKeys.all(organizationId), 'list'],
      });
    },
  });
  const markReadRef = useRef(markReadMutation.mutate);
  markReadRef.current = markReadMutation.mutate;
  useEffect(() => {
    if (conversation && conversation.unreadCount > 0) {
      markReadRef.current();
    }
  }, [conversation, conversation?.unreadCount, conversation?.lastInboundMessageAt]);

  // Défilement automatique vers le bas à chaque nouveau message.
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastMessageId]);

  const invalidateConversation = () => {
    void queryClient.invalidateQueries({
      queryKey: conversationKeys.detail(organizationId, conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: [...conversationKeys.all(organizationId), 'list'],
    });
  };

  const statusMutation = useMutation({
    mutationFn: (status: ConversationStatus) =>
      conversationsApi.updateStatus(organizationId, conversationId, status),
    onSuccess: invalidateConversation,
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const assignMutation = useMutation({
    mutationFn: (membershipId: string | null) =>
      membershipId === null
        ? conversationsApi.unassign(organizationId, conversationId)
        : conversationsApi.assign(organizationId, conversationId, membershipId),
    onSuccess: invalidateConversation,
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const noteMutation = useMutation({
    mutationFn: (text: string) => conversationsApi.addNote(organizationId, conversationId, text),
    onSuccess: () => {
      // Le socket insère la note ; l'invalidation couvre le cas hors-ligne.
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.messages(organizationId, conversationId),
      });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (conversationQuery.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (conversationQuery.isError || !conversation) {
    return (
      <div className="p-4">
        <ErrorState
          error={conversationQuery.error}
          onRetry={() => void conversationQuery.refetch()}
        />
      </div>
    );
  }

  const windowOpen =
    conversation.customerServiceWindowExpiresAt !== null &&
    new Date(conversation.customerServiceWindowExpiresAt).getTime() > Date.now();
  const conversationWritable =
    conversation.status !== 'CLOSED' && conversation.status !== 'RESOLVED';
  const canReplyNow = can(PERMISSIONS.CONVERSATIONS_REPLY) && conversationWritable && windowOpen;
  const replyDisabledReason = !conversationWritable
    ? 'Conversation résolue ou fermée — rouvrez-la pour répondre.'
    : !windowOpen
      ? 'Fenêtre de service de 24 h expirée : le client doit écrire à nouveau avant tout message libre.'
      : undefined;

  const sendReply = (text: string) => {
    sendMutation.mutate(
      { text, clientMessageId: crypto.randomUUID() },
      { onError: (error) => toast.error(getErrorMessage(error)) },
    );
  };

  const resendOptimistic = (message: Message) => {
    if (message.clientMessageId && message.textContent) {
      // MÊME clientMessageId : si le serveur avait déjà créé le message avant
      // la panne réseau, il renvoie l'existant — jamais de doublon.
      sendMutation.mutate(
        { text: message.textContent, clientMessageId: message.clientMessageId },
        { onError: (error) => toast.error(getErrorMessage(error)) },
      );
    }
  };

  const groups = groupByDay(messages);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* En-tête du fil */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onBack}
          aria-label="Retour à la liste"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback>{contactInitials(conversation.contact)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{contactLabel(conversation.contact)}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conversation.contact.whatsappPhone}
          </p>
        </div>

        {/* Statut */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              disabled={!can(PERMISSIONS.CONVERSATIONS_UPDATE_STATUS) || statusMutation.isPending}
              data-testid="status-menu"
            >
              {CONVERSATION_STATUS_LABELS[conversation.status]}
              <ChevronDown aria-hidden className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Changer le statut</DropdownMenuLabel>
            {NEXT_STATUSES[conversation.status].length === 0 ? (
              <DropdownMenuItem disabled>Conversation fermée (terminal)</DropdownMenuItem>
            ) : (
              NEXT_STATUSES[conversation.status].map((status) => (
                <DropdownMenuItem key={status} onSelect={() => statusMutation.mutate(status)}>
                  {CONVERSATION_STATUS_LABELS[status]}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Assignation */}
        {can(PERMISSIONS.CONVERSATIONS_ASSIGN) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="max-w-36 gap-1 text-xs"
                disabled={assignMutation.isPending}
                data-testid="assign-menu"
              >
                <span className="truncate">
                  {conversation.assignedMembership
                    ? `→ ${conversation.assignedMembership.user.firstName}`
                    : 'Assigner'}
                </span>
                <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Assigner à</DropdownMenuLabel>
              {(membersQuery.data?.items ?? []).map((member) => (
                <DropdownMenuItem
                  key={member.membershipId}
                  onSelect={() => assignMutation.mutate(member.membershipId)}
                >
                  <span className="flex-1 truncate">
                    {member.firstName} {member.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground">{member.role}</span>
                </DropdownMenuItem>
              ))}
              {conversation.assignedMembershipId !== null ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => assignMutation.mutate(null)}>
                    Retirer l’assignation
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {can(PERMISSIONS.PRODUCTS_READ) ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setPickerOpen(true)}
            aria-label="Ajouter un produit"
            data-testid="add-product-button"
          >
            <PackagePlus aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleContactPanel}
          aria-label="Afficher la fiche contact"
        >
          <Info aria-hidden className="h-4 w-4" />
        </Button>
      </div>

      {/* Fil */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4">
        {messagesQuery.hasNextPage ? (
          <div className="mb-3 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={messagesQuery.isFetchingNextPage}
              onClick={() => void messagesQuery.fetchNextPage()}
            >
              {messagesQuery.isFetchingNextPage ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : null}
              Messages précédents
            </Button>
          </div>
        ) : null}
        <div className="space-y-2">
          {groups.map((group) => (
            <div key={group.day} className="space-y-2">
              <div className="flex justify-center">
                <Badge variant="secondary" className="text-[10px] font-normal capitalize">
                  {dayLabel(group.items[0].createdAt)}
                </Badge>
              </div>
              {group.items.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRetry={(messageId) =>
                    retryMutation.mutate(messageId, {
                      onError: (error) => toast.error(getErrorMessage(error)),
                    })
                  }
                  onResend={resendOptimistic}
                />
              ))}
            </div>
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Suggestion IA (au-dessus du composer ; l'insertion ne fait que préremplir) */}
      <SuggestionPanel conversationId={conversationId} onInsert={insert} />

      {/* Composer */}
      <Composer
        onSendReply={sendReply}
        onAddNote={(text) => noteMutation.mutate(text)}
        canReply={canReplyNow}
        canAddNote={can(PERMISSIONS.CONVERSATIONS_ADD_NOTE)}
        replyDisabledReason={replyDisabledReason}
        isSending={sendMutation.isPending || noteMutation.isPending}
        insertText={insertText}
      />

      {pickerOpen ? (
        <ProductPickerDialog onInsert={insert} onClose={() => setPickerOpen(false)} />
      ) : null}
    </div>
  );
}
