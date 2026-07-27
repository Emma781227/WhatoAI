'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';
import { messages } from '@/lib/messages';

import { invitationKeys, invitationsApi, type InvitationRole } from '../api';

const inviteSchema = z.object({
  email: z.string().email('Adresse email invalide'),
  role: z.enum(['ADMIN', 'MANAGER', 'AGENT']),
});
type InviteValues = z.infer<typeof inviteSchema>;

/** Rôles invitables (jamais OWNER) — la hiérarchie exacte est revalidée par le backend. */
const INVITABLE_ROLES: InvitationRole[] = ['ADMIN', 'MANAGER', 'AGENT'];

export function InviteMemberDialog({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'AGENT' },
  });

  async function onSubmit(values: InviteValues) {
    setFormError(null);
    try {
      const result = await invitationsApi.create(organizationId, values);
      await queryClient.invalidateQueries({ queryKey: invitationKeys.all(organizationId) });
      toast.success(
        result.resent
          ? `Invitation renouvelée pour ${values.email}`
          : `Invitation envoyée à ${values.email}`,
      );
      if (result.devLink) {
        setDevLink(result.devLink);
        form.reset();
        return; // Garde le dialogue ouvert pour exposer le lien de dev.
      }
      form.reset();
      setOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'USER_ALREADY_MEMBER') {
        form.setError('email', { message: 'Cette personne est déjà membre de l’organisation.' });
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setDevLink(null);
          setFormError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus aria-hidden />
          Inviter un membre
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Inviter un membre</DialogTitle>
          <DialogDescription>
            La personne recevra un email d’invitation valable 7 jours.
          </DialogDescription>
        </DialogHeader>
        {devLink ? (
          <Alert variant="info">
            <AlertDescription>
              Mode développement — lien d’acceptation :{' '}
              <Link
                href={devLink.replace(/^https?:\/\/[^/]+/, '')}
                className="break-all font-medium underline"
                target="_blank"
              >
                ouvrir le lien
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="collegue@entreprise.cm" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rôle</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {INVITABLE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {messages.roles[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              Envoyer l’invitation
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
