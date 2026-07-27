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
import { PERMISSIONS } from '@/lib/permissions/constants';
import { usePermissions } from '@/lib/permissions/use-permissions';

import { whatsappChannelKeys, whatsappChannelsApi } from '../api';

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

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <MessageCircle aria-hidden className="mx-auto h-10 w-10 text-primary" />
          <CardTitle>Connecter WhatsApp</CardTitle>
          <CardDescription>
            {can(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
              ? 'Connectez un canal WhatsApp de démonstration (simulation) pour recevoir et envoyer des messages dans cette boutique.'
              : 'Aucun canal WhatsApp n’est connecté à cette boutique. Contactez un administrateur pour le configurer.'}
          </CardDescription>
        </CardHeader>
        {can(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE) ? (
          <CardContent>
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
              <Button type="submit" className="w-full" disabled={connectMutation.isPending}>
                Connecter le canal (simulation)
              </Button>
            </form>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
