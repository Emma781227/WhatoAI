'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useOrganization } from '@/features/organizations/organization-provider';
import { getErrorMessage } from '@/lib/api/api-error';

import {
  WHATSAPP_BUSINESS_VERTICALS,
  whatsappChannelKeys,
  whatsappChannelsApi,
  type WhatsAppBusinessProfile,
} from '../api';

const optionalUrl = z.union([z.literal(''), z.string().url().max(256)]);

const profileSchema = z.object({
  about: z.string().max(139),
  address: z.string().max(256),
  description: z.string().max(512),
  email: z.union([z.literal(''), z.string().email().max(128)]),
  // Le Select contraint déjà les choix et le backend valide l'enum (@IsIn) :
  // pas de duplication stricte côté client (évite aussi un flake jsdom/Radix).
  vertical: z.string(),
  website1: optionalUrl,
  website2: optionalUrl,
});

type ProfileFormValues = z.infer<typeof profileSchema>;

function toFormValues(profile: WhatsAppBusinessProfile): ProfileFormValues {
  return {
    about: profile.about ?? '',
    address: profile.address ?? '',
    description: profile.description ?? '',
    email: profile.email ?? '',
    vertical: (WHATSAPP_BUSINESS_VERTICALS as readonly string[]).includes(profile.vertical ?? '')
      ? (profile.vertical as ProfileFormValues['vertical'])
      : 'UNDEFINED',
    website1: profile.websites[0] ?? '',
    website2: profile.websites[1] ?? '',
  };
}

/**
 * Édition du profil WhatsApp Business depuis Whauto (le commerçant ne retourne
 * pas dans Meta Business Manager). La photo de profil n'est pas gérée ici.
 */
export function WhatsAppProfileForm({ shopId }: { shopId: string }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: whatsappChannelKeys.profile(organizationId, shopId),
    queryFn: () => whatsappChannelsApi.getProfile(organizationId, shopId),
  });

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      about: '',
      address: '',
      description: '',
      email: '',
      vertical: 'UNDEFINED',
      website1: '',
      website2: '',
    },
  });

  // Réinitialise le formulaire dès que le profil serveur arrive/change.
  useEffect(() => {
    if (profileQuery.data) {
      form.reset(toFormValues(profileQuery.data));
    }
  }, [profileQuery.data, form]);

  const mutation = useMutation({
    mutationFn: (values: ProfileFormValues) =>
      whatsappChannelsApi.updateProfile(organizationId, shopId, {
        about: values.about,
        address: values.address,
        description: values.description,
        email: values.email,
        vertical: values.vertical,
        websites: [values.website1, values.website2].filter((w): w is string => w.length > 0),
      }),
    onSuccess: (fresh) => {
      toast.success('Profil WhatsApp mis à jour.');
      queryClient.setQueryData(whatsappChannelKeys.profile(organizationId, shopId), fresh);
      form.reset(toFormValues(fresh));
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  if (profileQuery.isPending) {
    return <p className="text-sm text-muted-foreground">Chargement du profil…</p>;
  }
  if (profileQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="profile-load-error">
        {getErrorMessage(profileQuery.error)}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profil WhatsApp Business</CardTitle>
        <CardDescription>
          Ces informations sont visibles par vos clients dans WhatsApp. La photo de profil se
          gère pour l’instant depuis WhatsApp directement.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-5"
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          >
            <FormField
              control={form.control}
              name="about"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>À propos</FormLabel>
                  <FormControl>
                    <Input maxLength={139} placeholder="Votre boutique en une phrase" {...field} />
                  </FormControl>
                  <FormDescription>Max 139 caractères.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea maxLength={512} rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Adresse</FormLabel>
                  <FormControl>
                    <Input maxLength={256} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email de contact</FormLabel>
                  <FormControl>
                    <Input type="email" maxLength={128} placeholder="contact@boutique.cm" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="vertical"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Secteur d’activité</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {WHATSAPP_BUSINESS_VERTICALS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="website1"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Site web 1</FormLabel>
                    <FormControl>
                      <Input type="url" placeholder="https://…" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="website2"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Site web 2</FormLabel>
                    <FormControl>
                      <Input type="url" placeholder="https://…" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Enregistrement…' : 'Enregistrer le profil'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
