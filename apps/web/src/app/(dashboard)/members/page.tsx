'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/empty-state';
import { ErrorState } from '@/components/feedback/error-state';
import { PageHeader } from '@/components/layout/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InviteMemberDialog } from '@/features/invitations/components/invite-member-dialog';
import { memberKeys, membershipsApi, type Member } from '@/features/memberships/api';
import { organizationKeys } from '@/features/organizations/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { useAuth } from '@/lib/auth/auth-provider';
import { messages } from '@/lib/messages';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { Can, usePermissions } from '@/lib/permissions/use-permissions';

const PAGE_SIZE = 20;

/** Rôles assignables via l'UI (jamais OWNER) — le backend revalide la hiérarchie. */
const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'AGENT'] as const;

export default function MembersPage() {
  const { activeOrganization } = useOrganization();
  const { can, role } = usePermissions();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const organizationId = activeOrganization.organization.id;

  const membersQuery = useQuery({
    queryKey: memberKeys.list(organizationId, page),
    queryFn: () => membershipsApi.list(organizationId, { page, limit: PAGE_SIZE }),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: memberKeys.all(organizationId) });

  const updateRoleMutation = useMutation({
    mutationFn: (input: { membershipId: string; role: (typeof ASSIGNABLE_ROLES)[number] }) =>
      membershipsApi.updateRole(organizationId, input.membershipId, input.role),
    onSuccess: (member) => {
      toast.success(`Rôle de ${member.firstName} mis à jour`);
      void invalidate();
    },
    onError: (error) => {
      // L'état a pu changer côté serveur (403/404) : message + resynchronisation.
      toast.error(getErrorMessage(error));
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: organizationKeys.detail(organizationId) });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (membershipId: string) => membershipsApi.remove(organizationId, membershipId),
    onSuccess: () => {
      toast.success('Membre retiré');
      void invalidate();
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
      void invalidate();
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => membershipsApi.leave(organizationId),
    onSuccess: async () => {
      toast.success('Vous avez quitté l’organisation');
      await queryClient.invalidateQueries({ queryKey: organizationKeys.list() });
      router.replace('/dashboard');
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  /** Cible modifiable par l'acteur ? (miroir de la hiérarchie backend, pour l'affichage) */
  function canManage(member: Member): boolean {
    if (member.userId === user?.id || member.role === 'OWNER') {
      return false;
    }
    if (role === 'OWNER') {
      return true;
    }
    if (role === 'ADMIN') {
      return member.role === 'MANAGER' || member.role === 'AGENT';
    }
    return false;
  }

  const totalPages = membersQuery.data ? Math.max(1, Math.ceil(membersQuery.data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <PageHeader
        title="Membres"
        description={`Équipe de ${activeOrganization.organization.name}`}
        actions={
          <div className="flex items-center gap-2">
            {role !== 'OWNER' ? (
              <ConfirmDialog
                trigger={
                  <Button variant="outline">
                    <LogOut aria-hidden />
                    Quitter l’organisation
                  </Button>
                }
                title="Quitter l’organisation ?"
                description="Vous perdrez l’accès à toutes les données de cette organisation. Un propriétaire pourra vous réinviter."
                confirmLabel="Quitter"
                destructive
                onConfirm={() => leaveMutation.mutate()}
              />
            ) : null}
            <Can permission={PERMISSIONS.MEMBERS_INVITE}>
              <InviteMemberDialog organizationId={organizationId} />
            </Can>
          </div>
        }
      />

      <Card>
        <CardContent className="pt-6">
          {membersQuery.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : membersQuery.isError ? (
            <ErrorState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
          ) : membersQuery.data.items.length === 0 ? (
            <EmptyState icon={Users} title="Aucun membre" description="Invitez votre équipe pour collaborer." />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Membre</TableHead>
                    <TableHead>Rôle</TableHead>
                    <TableHead>Depuis</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {membersQuery.data.items.map((member) => (
                    <TableRow key={member.membershipId}>
                      <TableCell>
                        <div className="font-medium">
                          {member.firstName} {member.lastName}
                          {member.userId === user?.id ? (
                            <span className="ml-2 text-xs text-muted-foreground">(vous)</span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{member.email}</div>
                      </TableCell>
                      <TableCell>
                        {canManage(member) && can(PERMISSIONS.MEMBERS_UPDATE_ROLE) ? (
                          <Select
                            value={member.role}
                            onValueChange={(value) =>
                              updateRoleMutation.mutate({
                                membershipId: member.membershipId,
                                role: value as (typeof ASSIGNABLE_ROLES)[number],
                              })
                            }
                          >
                            <SelectTrigger className="w-40" aria-label={`Rôle de ${member.firstName}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE_ROLES.map((assignable) => (
                                <SelectItem key={assignable} value={assignable}>
                                  {messages.roles[assignable]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant={member.role === 'OWNER' ? 'default' : 'secondary'}>
                            {messages.roles[member.role]}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(member.joinedAt).toLocaleDateString('fr-FR')}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage(member) && can(PERMISSIONS.MEMBERS_REMOVE) ? (
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="sm" className="text-destructive">
                                Retirer
                              </Button>
                            }
                            title={`Retirer ${member.firstName} ${member.lastName} ?`}
                            description="Le membre perdra immédiatement l’accès à l’organisation. Il pourra être réinvité plus tard."
                            confirmLabel="Retirer"
                            destructive
                            onConfirm={() => removeMutation.mutate(member.membershipId)}
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
                    Page {page} sur {totalPages} · {membersQuery.data.total} membres
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
