'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { contactKeys, contactsApi, type Contact } from '@/features/contacts/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

function EditContactDialog({
  contact,
  onClose,
}: {
  contact: Contact;
  onClose: () => void;
}) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(contact.displayName ?? '');
  const [city, setCity] = useState(contact.city ?? '');
  const [notes, setNotes] = useState(contact.notes ?? '');

  const updateMutation = useMutation({
    mutationFn: () =>
      contactsApi.update(organizationId, contact.id, {
        // Convention PATCH : chaîne vide = effacement (null), sinon valeur.
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        city: city.trim() === '' ? null : city.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      }),
    onSuccess: () => {
      toast.success('Contact mis à jour.');
      void queryClient.invalidateQueries({ queryKey: contactKeys.all(organizationId) });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Modifier le contact</DialogTitle>
          <DialogDescription>{contact.whatsappPhone} — le numéro n’est pas modifiable.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="contact-name">Nom affiché</Label>
            <Input
              id="contact-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-city">Ville</Label>
            <Input
              id="contact-city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-notes">Notes internes</Label>
            <Textarea
              id="contact-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              maxLength={2000}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              Enregistrer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ContactsPage() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const { activeShop } = useActiveShop();
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Contact | null>(null);

  const params = {
    shopId: activeShop?.id,
    search: search.trim() === '' ? undefined : search.trim(),
    page,
    limit: 20,
  };
  const query = useQuery({
    queryKey: contactKeys.list(organizationId, params),
    queryFn: () => contactsApi.list(organizationId, params),
  });

  const contacts = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-bold">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            {activeShop ? `Boutique ${activeShop.name}` : 'Toutes les boutiques'} — {total} contact(s)
          </p>
        </div>
        <div className="relative w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Rechercher (nom, téléphone)…"
            className="pl-8"
            aria-label="Rechercher un contact"
          />
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : contacts.length === 0 ? (
        <EmptyState
          title="Aucun contact"
          description="Les contacts sont créés automatiquement à la réception de leur premier message WhatsApp."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Téléphone</TableHead>
                <TableHead>Ville</TableHead>
                <TableHead>Dernière activité</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">{contact.displayName ?? '—'}</TableCell>
                  <TableCell>{contact.whatsappPhone}</TableCell>
                  <TableCell>{contact.city ?? '—'}</TableCell>
                  <TableCell>
                    {new Date(contact.lastActivityAt).toLocaleString('fr-FR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                  <TableCell>
                    {can(PERMISSIONS.CONTACTS_UPDATE) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(contact)}
                        aria-label={`Modifier ${contact.displayName ?? contact.whatsappPhone}`}
                      >
                        <Pencil aria-hidden className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Précédent
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} / {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Suivant
              </Button>
            </div>
          ) : null}
        </>
      )}

      {editing ? <EditContactDialog contact={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
