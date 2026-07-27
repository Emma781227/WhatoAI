'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { PageHeader } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { invitationKeys, invitationsApi, type InvitationStatus } from '@/features/invitations/api';
import { InviteMemberDialog } from '@/features/invitations/components/invite-member-dialog';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { messages } from '@/lib/messages';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

const PAGE_SIZE = 20;

const STATUS_VARIANT: Record<InvitationStatus, 'default' | 'secondary' | 'warning' | 'destructive' | 'muted'> = {
  PENDING: 'warning',
  ACCEPTED: 'default',
  DECLINED: 'muted',
  CANCELLED: 'muted',
  EXPIRED: 'muted',
};

export default function InvitationsPage() {
  const { activeOrganization } = useOrganization();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const organizationId = activeOrganization.organization.id;

  const invitationsQuery = useQuery({
    queryKey: invitationKeys.list(organizationId, page),
    queryFn: () => invitationsApi.list(organizationId, { page, limit: PAGE_SIZE }),
    enabled: can(PERMISSIONS.INVITATIONS_READ),
  });

  const cancelMutation = useMutation({
    mutationFn: (invitationId: string) => invitationsApi.cancel(organizationId, invitationId),
    onSuccess: () => {
      toast.success('Invitation annulée');
      void queryClient.invalidateQueries({ queryKey: invitationKeys.all(organizationId) });
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
      void queryClient.invalidateQueries({ queryKey: invitationKeys.all(organizationId) });
    },
  });

  if (!can(PERMISSIONS.INVITATIONS_READ)) {
    return (
      <div>
        <PageHeader title="Invitations" />
        <EmptyState
          icon={Mail}
          title="Accès restreint"
          description="Votre rôle ne permet pas de consulter les invitations de l’organisation."
        />
      </div>
    );
  }

  const totalPages = invitationsQuery.data
    ? Math.max(1, Math.ceil(invitationsQuery.data.total / PAGE_SIZE))
    : 1;

  return (
    <div>
      <PageHeader
        title="Invitations"
        description={`Invitations de ${activeOrganization.organization.name}`}
        actions={
          <Can permission={PERMISSIONS.MEMBERS_INVITE}>
            <InviteMemberDialog organizationId={organizationId} />
          </Can>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {invitationsQuery.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : invitationsQuery.isError ? (
            <ErrorState error={invitationsQuery.error} onRetry={() => void invitationsQuery.refetch()} />
          ) : invitationsQuery.data.items.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="Aucune invitation"
              description="Les invitations envoyées apparaîtront ici avec leur statut."
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Rôle</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Expire le</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitationsQuery.data.items.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell className="font-medium">{invitation.email}</TableCell>
                      <TableCell>{messages.roles[invitation.role]}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[invitation.status]}>
                          {messages.invitationStatus[invitation.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(invitation.expiresAt).toLocaleDateString('fr-FR')}
                      </TableCell>
                      <TableCell className="text-right">
                        {invitation.status === 'PENDING' && can(PERMISSIONS.INVITATIONS_CANCEL) ? (
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="sm" className="text-destructive">
                                Annuler
                              </Button>
                            }
                            title={`Annuler l’invitation de ${invitation.email} ?`}
                            description="Le lien d’invitation deviendra immédiatement inutilisable."
                            confirmLabel="Annuler l’invitation"
                            destructive
                            onConfirm={() => cancelMutation.mutate(invitation.id)}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {totalPages > 1 ? (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Page {page} sur {totalPages} · {invitationsQuery.data.total} invitations
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      Précédent
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage(page + 1)}
                    >
                      Suivant
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
