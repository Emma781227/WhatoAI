'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import {
  EmbeddedSignupError,
  launchEmbeddedSignup as defaultLaunch,
  type EmbeddedSignupResult,
} from '@/lib/meta/embedded-signup';

import { whatsappChannelKeys, whatsappChannelsApi } from '../api';

interface MetaConnectButtonProps {
  shopId: string;
  /** Injectable pour les tests — par défaut le vrai lanceur SDK Meta. */
  launch?: () => Promise<EmbeddedSignupResult>;
}

/**
 * Bouton « Connecter mon WhatsApp Business » : lance l'Embedded Signup Meta,
 * puis transmet le `code` + identifiants au backend qui provisionne le canal.
 * Le frontend ne confirme JAMAIS une connexion lui-même — l'état « connecté »
 * ne vient que de la réponse serveur (refetch du canal).
 */
export function MetaConnectButton({ shopId, launch = defaultLaunch }: MetaConnectButtonProps) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const [launching, setLaunching] = useState(false);

  const onboardMutation = useMutation({
    mutationFn: (result: EmbeddedSignupResult) =>
      whatsappChannelsApi.embeddedSignup(organizationId, shopId, result),
    onSuccess: () => {
      toast.success('WhatsApp Business connecté.');
      void queryClient.invalidateQueries({
        queryKey: whatsappChannelKeys.forShop(organizationId, shopId),
      });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const busy = launching || onboardMutation.isPending;

  async function handleClick() {
    setLaunching(true);
    try {
      const result = await launch();
      onboardMutation.mutate(result);
    } catch (error) {
      // L'annulation par l'utilisateur n'est pas une erreur bloquante.
      if (error instanceof EmbeddedSignupError && error.code === 'CANCELLED') {
        toast.info('Connexion WhatsApp annulée.');
      } else {
        toast.error(getErrorMessage(error));
      }
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Button type="button" className="w-full" onClick={handleClick} disabled={busy}>
      {busy ? 'Connexion en cours…' : 'Connecter mon WhatsApp Business'}
    </Button>
  );
}
