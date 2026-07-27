'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { TimezoneInput } from '@/components/forms/timezone-input';
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
import { messages } from '@/lib/messages';

import { ORGANIZATION_FORM_DEFAULTS, organizationFormSchema, type OrganizationFormValues } from '../schemas';

interface OrganizationFormProps {
  defaultValues?: Partial<OrganizationFormValues>;
  submitLabel?: string;
  onSubmit: (values: OrganizationFormValues) => Promise<void>;
}

export function OrganizationForm({ defaultValues, submitLabel, onSubmit }: OrganizationFormProps) {
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<OrganizationFormValues>({
    resolver: zodResolver(organizationFormSchema),
    defaultValues: { ...ORGANIZATION_FORM_DEFAULTS, ...defaultValues },
  });

  async function handleSubmit(values: OrganizationFormValues) {
    setFormError(null);
    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ORGANIZATION_SLUG_ALREADY_USED') {
        form.setError('slug', { message: 'Ce slug est déjà utilisé.' });
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4" noValidate>
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
              <FormLabel>Nom de l’organisation</FormLabel>
              <FormControl>
                <Input placeholder="Ma Boutique SARL" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Slug (optionnel)</FormLabel>
              <FormControl>
                <Input placeholder="ma-boutique" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormDescription>Généré automatiquement depuis le nom si laissé vide.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Fuseau horaire</FormLabel>
                <FormControl>
                  <TimezoneInput {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="defaultCurrency"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Devise</FormLabel>
                <FormControl>
                  <Input maxLength={3} placeholder="XAF" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="defaultLocale"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Langue</FormLabel>
                <FormControl>
                  <Input placeholder="fr" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <Button type="submit" loading={form.formState.isSubmitting}>
          {submitLabel ?? messages.actions.save}
        </Button>
      </form>
    </Form>
  );
}
