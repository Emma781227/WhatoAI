'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { ApiError, getErrorMessage } from '@/lib/api/api-error';

import { shopsApi, type Shop } from '../api';

const quickCreateSchema = z.object({
  name: z.string().trim().min(2, 'Au moins 2 caractères').max(100),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Code pays ISO à 2 lettres (ex. CM)'),
});
type QuickCreateValues = z.infer<typeof quickCreateSchema>;

interface QuickCreateShopFormProps {
  organizationId: string;
  submitLabel?: string;
  onCreated: (shop: Shop) => void;
}

/** Création rapide (onboarding) : nom + pays — le reste hérite de l'organisation. */
export function QuickCreateShopForm({ organizationId, submitLabel, onCreated }: QuickCreateShopFormProps) {
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<QuickCreateValues>({
    resolver: zodResolver(quickCreateSchema),
    defaultValues: { name: '', countryCode: 'CM' },
  });

  async function onSubmit(values: QuickCreateValues) {
    setFormError(null);
    try {
      onCreated(await shopsApi.create(organizationId, values));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SHOP_SLUG_ALREADY_USED') {
        form.setError('name', { message: 'Une boutique avec un nom similaire existe déjà.' });
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nom de la boutique</FormLabel>
              <FormControl>
                <Input placeholder="Boutique Centre-Ville" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="countryCode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pays</FormLabel>
              <FormControl>
                <Input maxLength={2} placeholder="CM" className="w-24 uppercase" {...field} />
              </FormControl>
              <FormDescription>
                Fuseau horaire, devise et langue sont hérités de l’organisation (modifiables ensuite).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" loading={form.formState.isSubmitting}>
          {submitLabel ?? 'Créer la boutique'}
        </Button>
      </form>
    </Form>
  );
}
