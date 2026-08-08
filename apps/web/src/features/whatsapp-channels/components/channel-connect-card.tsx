'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getErrorMessage } from '@/lib/api/api-error';
import { isMetaEmbeddedSignupConfigured } from '@/lib/env';
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

import { whatsappChannelKeys, whatsappChannelsApi } from '../api';
import { MetaConnectButton } from './meta-connect-button';

/**
 * État vide de l'inbox quand la Shop n'a pas de canal : connexion d'un canal
 * MOCK (aucun secret Meta — le vrai onboarding Meta Cloud viendra plus tard).
 */
export function ChannelConnectCard({ shopId, shopName }: { shopId: string; shopName: string }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { can } = usePermissions();

  const [displayName, setDisplayName] = useState(shopName);
  const [phoneNumber, setPhoneNumber] = useState('');

  const connectMutation = useMutation({
    mutationFn: () =>
      whatsappChannelsApi.connectMock(organizationId, shopId, { displayName, phoneNumber }),
    onSuccess: () => {
      toast.success('Canal WhatsApp connecté (simulation).');
      void queryClient.invalidateQueries({
        queryKey: whatsappChannelKeys.forShop(organizationId, shopId),
      });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const canManage = can(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE);
  const metaAvailable = isMetaEmbeddedSignupConfigured;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <MessageCircle aria-hidden className="mx-auto h-10 w-10 text-primary" />
          <CardTitle>Connecter WhatsApp</CardTitle>
          <CardDescription>
            {!canManage
              ? 'Aucun canal WhatsApp n’est connecté à cette boutique. Contactez un administrateur pour le configurer.'
              : metaAvailable
                ? 'Connectez le numéro WhatsApp Business de votre boutique pour recevoir et envoyer des messages depuis Whauto AI.'
                : 'Connectez un canal WhatsApp de démonstration (simulation) pour recevoir et envoyer des messages dans cette boutique.'}
          </CardDescription>
        </CardHeader>
        {canManage ? (
          <CardContent className="space-y-6">
            {metaAvailable ? (
              <div className="space-y-3">
                <MetaConnectButton shopId={shopId} />
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li>
                    • <span className="font-medium">J’ai déjà un numéro WhatsApp Business</span> :
                    connectez-le directement.
                  </li>
                  <li>
                    • <span className="font-medium">Je veux un nouveau numéro</span> : créez-le
                    pendant la connexion Meta.
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground">
                  Vous serez redirigé vers Meta pour autoriser Whauto AI. Nous ne voyons jamais
                  votre mot de passe Meta.
                </p>
              </div>
            ) : null}

            {metaAvailable ? (
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">ou démonstration</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                connectMutation.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="channel-display-name">Nom affiché</Label>
                <Input
                  id="channel-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={100}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="channel-phone">Numéro WhatsApp (format international)</Label>
                <Input
                  id="channel-phone"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="+237650000000"
                  required
                  maxLength={20}
                />
              </div>
              <Button
                type="submit"
                variant={metaAvailable ? 'outline' : 'default'}
                className="w-full"
                disabled={connectMutation.isPending}
              >
                Connecter le canal (simulation)
              </Button>
            </form>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
