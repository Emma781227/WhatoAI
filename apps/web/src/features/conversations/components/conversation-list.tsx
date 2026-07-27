'use client';

import { Loader2, Search } from 'lucide-react';
import { useState } from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { cn } from '@/lib/utils';

import type { Conversation, ConversationStatus } from '../api';
import {
  CONVERSATION_STATUS_LABELS,
  contactInitials,
  contactLabel,
  relativeTime,
} from '../format';
import { useConversationsList } from '../use-conversations';

const STATUS_FILTERS: Array<{ value: 'ALL' | ConversationStatus; label: string }> = [
  { value: 'ALL', label: 'Tous les statuts' },
  { value: 'OPEN', label: CONVERSATION_STATUS_LABELS.OPEN },
  { value: 'PENDING', label: CONVERSATION_STATUS_LABELS.PENDING },
  { value: 'RESOLVED', label: CONVERSATION_STATUS_LABELS.RESOLVED },
  { value: 'CLOSED', label: CONVERSATION_STATUS_LABELS.CLOSED },
];

function ConversationRow({
  conversation,
  isActive,
  onSelect,
}: {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversationId: string) => void;
}) {
  const preview =
    conversation.lastMessage?.type === 'INTERNAL_NOTE'
      ? `📝 ${conversation.lastMessage.textContent ?? ''}`
      : (conversation.lastMessage?.textContent ?? 'Aucun message');

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      className={cn(
        'flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-accent',
        isActive && 'bg-accent',
      )}
      data-testid="conversation-row"
    >
      <Avatar className="mt-0.5 shrink-0">
        <AvatarFallback>{contactInitials(conversation.contact)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-foreground">
            {contactLabel(conversation.contact)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime(conversation.lastMessageAt)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted-foreground">{preview}</span>
          {conversation.unreadCount > 0 ? (
            <Badge className="shrink-0 rounded-full px-1.5" data-testid="unread-badge">
              {conversation.unreadCount}
            </Badge>
          ) : null}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <Badge variant="outline" className="text-[10px]">
            {CONVERSATION_STATUS_LABELS[conversation.status]}
          </Badge>
          {conversation.assignedMembership ? (
            <Badge variant="secondary" className="text-[10px]">
              {conversation.assignedMembership.user.firstName}
            </Badge>
          ) : null}
          {conversation.tags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="text-[10px]">
              #{tag.name}
            </Badge>
          ))}
        </span>
      </span>
    </button>
  );
}

export function ConversationList({
  shopId,
  activeConversationId,
  onSelect,
}: {
  shopId: string;
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ConversationStatus>('ALL');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const query = useConversationsList({
    shopId,
    search: search.trim() === '' ? undefined : search.trim(),
    status: statusFilter === 'ALL' ? undefined : statusFilter,
    unreadOnly: unreadOnly ? true : undefined,
  });

  const conversations = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Rechercher un contact…"
            className="pl-8"
            aria-label="Rechercher une conversation"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as 'ALL' | ConversationStatus)}
          >
            <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Filtrer par statut">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant={unreadOnly ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => setUnreadOnly((value) => !value)}
            aria-pressed={unreadOnly}
          >
            Non lues
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : query.isError ? (
          <div className="p-4">
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState
            title="Aucune conversation"
            description="Les messages WhatsApp entrants de cette boutique apparaîtront ici en temps réel."
          />
        ) : (
          <>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                isActive={conversation.id === activeConversationId}
                onSelect={onSelect}
              />
            ))}
            {query.hasNextPage ? (
              <div className="p-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? (
                    <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                  ) : null}
                  Charger plus
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
