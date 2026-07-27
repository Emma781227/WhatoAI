'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { contactKeys, contactsApi } from '@/features/contacts/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

import { conversationKeys, conversationsApi, type Conversation } from '../api';
import { CONVERSATION_STATUS_LABELS, contactInitials, contactLabel } from '../format';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  );
}

/**
 * Fiche contact + contexte de la conversation. Uniquement des informations
 * réellement disponibles — aucun bloc commandes/panier/IA/statistiques tant
 * que ces modules n'existent pas.
 */
export function ContactPanel({ conversation }: { conversation: Conversation }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [newTag, setNewTag] = useState('');

  const contactQuery = useQuery({
    queryKey: contactKeys.detail(organizationId, conversation.contactId),
    queryFn: () => contactsApi.get(organizationId, conversation.contactId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: conversationKeys.detail(organizationId, conversation.id),
    });
    void queryClient.invalidateQueries({
      queryKey: [...conversationKeys.all(organizationId), 'list'],
    });
  };

  const addTagMutation = useMutation({
    mutationFn: (name: string) => conversationsApi.addTag(organizationId, conversation.id, name),
    onSuccess: () => {
      setNewTag('');
      invalidate();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const removeTagMutation = useMutation({
    mutationFn: (tagId: string) =>
      conversationsApi.removeTag(organizationId, conversation.id, tagId),
    onSuccess: invalidate,
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const contact = contactQuery.data;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-testid="contact-panel">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar className="h-16 w-16 text-lg">
          <AvatarFallback>{contactInitials(conversation.contact)}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium">{contactLabel(conversation.contact)}</p>
          <p className="text-sm text-muted-foreground">{conversation.contact.whatsappPhone}</p>
        </div>
      </div>

      <Separator />

      {contactQuery.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : contact ? (
        <dl className="grid grid-cols-2 gap-3">
          <Field label="Langue" value={contact.language} />
          <Field label="Ville" value={contact.city} />
          <Field label="Pays" value={contact.countryCode} />
          <Field label="Email" value={contact.email} />
        </dl>
      ) : null}

      {contact?.notes ? (
        <div>
          <p className="text-xs text-muted-foreground">Notes du contact</p>
          <p className="whitespace-pre-wrap text-sm">{contact.notes}</p>
        </div>
      ) : null}

      <Separator />

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">Tags</p>
        <div className="flex flex-wrap gap-1.5">
          {conversation.tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun tag</p>
          ) : (
            conversation.tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="gap-1">
                #{tag.name}
                {can(PERMISSIONS.CONVERSATIONS_MANAGE_TAGS) ? (
                  <button
                    type="button"
                    onClick={() => removeTagMutation.mutate(tag.id)}
                    aria-label={`Retirer le tag ${tag.name}`}
                    className="rounded-full hover:text-destructive"
                  >
                    <X aria-hidden className="h-3 w-3" />
                  </button>
                ) : null}
              </Badge>
            ))
          )}
        </div>
        <Can permission={PERMISSIONS.CONVERSATIONS_MANAGE_TAGS}>
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newTag.trim();
              if (name !== '') {
                addTagMutation.mutate(name);
              }
            }}
          >
            <Input
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
              placeholder="Ajouter un tag…"
              maxLength={50}
              className="h-8 text-xs"
              aria-label="Nouveau tag"
            />
            <Button
              type="submit"
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              disabled={newTag.trim() === '' || addTagMutation.isPending}
              aria-label="Ajouter le tag"
            >
              <Plus aria-hidden className="h-4 w-4" />
            </Button>
          </form>
        </Can>
      </div>

      <Separator />

      <dl className="grid grid-cols-1 gap-3">
        <Field label="Boutique" value={activeShop?.name ?? null} />
        <Field label="Statut de la conversation" value={CONVERSATION_STATUS_LABELS[conversation.status]} />
        <Field
          label="Assignée à"
          value={
            conversation.assignedMembership
              ? `${conversation.assignedMembership.user.firstName} ${conversation.assignedMembership.user.lastName}`
              : null
          }
        />
        <Field
          label="Fenêtre de service (24 h)"
          value={
            conversation.customerServiceWindowExpiresAt
              ? new Date(conversation.customerServiceWindowExpiresAt).getTime() > Date.now()
                ? `Ouverte jusqu'à ${new Date(conversation.customerServiceWindowExpiresAt).toLocaleString('fr-FR')}`
                : 'Expirée'
              : 'Jamais ouverte'
          }
        />
      </dl>
    </div>
  );
}
