'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { PasswordInput } from '@/components/forms/password-input';
import { getErrorMessage } from '@/lib/api/api-error';

import { authApi } from '../api';
import { resetPasswordSchema, type ResetPasswordValues } from '../schemas';

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Token conservé en mémoire uniquement, retiré de l'URL, jamais loggé.
  const tokenRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');
    if (token) {
      tokenRef.current = token;
      router.replace('/reset-password');
    }
  }, [searchParams, router]);

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  async function onSubmit(values: ResetPasswordValues) {
    setFormError(null);
    if (!tokenRef.current) {
      setFormError('Lien de réinitialisation manquant ou déjà utilisé. Redemandez un lien.');
      return;
    }
    try {
      await authApi.resetPassword({ token: tokenRef.current, newPassword: values.newPassword });
      tokenRef.current = null;
      setDone(true);
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Mot de passe réinitialisé</CardTitle>
          <CardDescription>Reconnectez-vous avec votre nouveau mot de passe.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Se connecter</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nouveau mot de passe</CardTitle>
        <CardDescription>Choisissez un nouveau mot de passe pour votre compte.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nouveau mot de passe</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirmer le mot de passe</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              Réinitialiser
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
