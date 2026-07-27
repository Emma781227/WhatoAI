'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CartPanel } from '@/features/carts/components/cart-panel';
import { OrdersPanel } from '@/features/orders/components/orders-panel';
import { ComposerInsertProvider } from '@/features/conversations/composer-insert';
import { ConversationList } from '@/features/conversations/components/conversation-list';
import { ContactPanel } from '@/features/conversations/components/contact-panel';
import { ConversationThread } from '@/features/conversations/components/conversation-thread';
import { useConversation } from '@/features/conversations/use-conversations';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { ChannelConnectCard } from '@/features/whatsapp-channels/components/channel-connect-card';
import { whatsappChannelKeys, whatsappChannelsApi } from '@/features/whatsapp-channels/api';
import { ApiError } from '@/lib/api/api-error';
import { cn } from '@/lib/utils';

/**
 * Inbox WhatsApp — trois panneaux desktop (liste / fil / contact), panneaux
 * successifs sur mobile pilotés par l'URL (?c=<conversationId>). Scoppée à la
 * Shop active (sélecteur topbar) : le remount par key du ShopProvider
 * garantit zéro flash inter-Shop.
 */
function ConversationsPageInner() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop, isLoading: shopsLoading } = useActiveShop();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeConversationId = searchParams.get('c');
  const [contactPanelOpen, setContactPanelOpen] = useState(false);
  const [rightTab, setRightTab] = useState<'contact' | 'cart' | 'orders'>('contact');

  const channelQuery = useQuery({
    queryKey: whatsappChannelKeys.forShop(organizationId, activeShop?.id ?? 'none'),
    queryFn: () => whatsappChannelsApi.get(organizationId, activeShop?.id as string),
    enabled: activeShop !== null,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
  });

  const activeConversationQuery = useConversation(activeConversationId);

  const selectConversation = useCallback(
    (conversationId: string) => {
      router.replace(`/conversations?c=${conversationId}`, { scroll: false });
    },
    [router],
  );
  const clearSelection = useCallback(() => {
    router.replace('/conversations', { scroll: false });
  }, [router]);

  if (shopsLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!activeShop) {
    return (
      <EmptyState
        title="Aucune boutique"
        description="Créez une boutique pour connecter un canal WhatsApp et recevoir des conversations."
      />
    );
  }

  const noChannel =
    channelQuery.isError &&
    channelQuery.error instanceof ApiError &&
    channelQuery.error.status === 404;

  if (channelQuery.isPending) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (noChannel) {
    return <ChannelConnectCard shopId={activeShop.id} shopName={activeShop.name} />;
  }
  if (channelQuery.isError) {
    return (
      <div className="p-6">
        <ErrorState error={channelQuery.error} onRetry={() => void channelQuery.refetch()} />
      </div>
    );
  }

  const hasSelection = activeConversationId !== null;

  return (
    // Hauteur pleine sous la topbar (h-14) : chaque colonne scrolle seule.
    // ComposerInsertProvider : canal partagé fil ↔ panneau droit (résumé panier).
    <ComposerInsertProvider>
    <div className="flex h-[calc(100dvh-3.5rem)]">
      {/* Liste — masquée sur mobile quand un fil est ouvert */}
      <div
        className={cn(
          'w-full shrink-0 border-r border-border bg-card lg:block lg:w-[360px]',
          hasSelection && 'hidden',
        )}
      >
        <ConversationList
          shopId={activeShop.id}
          activeConversationId={activeConversationId}
          onSelect={selectConversation}
        />
      </div>

      {/* Fil */}
      <div className={cn('min-w-0 flex-1 lg:block', !hasSelection && 'hidden')}>
        {hasSelection ? (
          <ConversationThread
            conversationId={activeConversationId}
            onBack={clearSelection}
            onToggleContactPanel={() => setContactPanelOpen((open) => !open)}
          />
        ) : (
          <div className="hidden h-full items-center justify-center lg:flex">
            <EmptyState
              title="Sélectionnez une conversation"
              description="Choisissez une conversation dans la liste pour afficher le fil de discussion."
            />
          </div>
        )}
      </div>

      {/* Panneau droit — onglets Contact / Panier (décision validée D11).
          Colonne desktop repliable, overlay mobile. */}
      {hasSelection && contactPanelOpen && activeConversationQuery.data ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-card lg:static lg:z-auto lg:w-[320px] lg:shrink-0 lg:border-l lg:border-border">
          <div className="flex items-center gap-1 border-b border-border p-2">
            <Button
              type="button"
              variant={rightTab === 'contact' ? 'secondary' : 'ghost'}
              size="sm"
              className="flex-1"
              onClick={() => setRightTab('contact')}
              aria-pressed={rightTab === 'contact'}
              data-testid="tab-contact"
            >
              Contact
            </Button>
            <Button
              type="button"
              variant={rightTab === 'cart' ? 'secondary' : 'ghost'}
              size="sm"
              className="flex-1"
              onClick={() => setRightTab('cart')}
              aria-pressed={rightTab === 'cart'}
              data-testid="tab-cart"
            >
              Panier
            </Button>
            <Button
              type="button"
              variant={rightTab === 'orders' ? 'secondary' : 'ghost'}
              size="sm"
              className="flex-1"
              onClick={() => setRightTab('orders')}
              aria-pressed={rightTab === 'orders'}
              data-testid="tab-orders"
            >
              Commandes
            </Button>
            <button
              type="button"
              onClick={() => setContactPanelOpen(false)}
              className="px-2 text-sm text-muted-foreground underline lg:hidden"
            >
              Fermer
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rightTab === 'contact' ? (
              <ContactPanel conversation={activeConversationQuery.data} />
            ) : rightTab === 'cart' ? (
              <CartPanel conversationId={activeConversationId!} />
            ) : (
              <OrdersPanel conversationId={activeConversationId!} />
            )}
          </div>
        </div>
      ) : null}
    </div>
    </ComposerInsertProvider>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-40 w-full" />}>
      <ConversationsPageInner />
    </Suspense>
  );
}
