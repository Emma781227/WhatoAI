'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { getErrorMessage } from '@/lib/api/api-error';

import { authApi } from '../api';
import { forgotPasswordSchema, type ForgotPasswordValues } from '../schemas';

export function ForgotPasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; devLink?: string } | null>(null);

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: ForgotPasswordValues) {
    setFormError(null);
    try {
      setResult(await authApi.forgotPassword(values.email));
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mot de passe oublié</CardTitle>
        <CardDescription>
          Indiquez votre email : si un compte existe, un lien de réinitialisation sera envoyé.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {result ? (
          <div className="space-y-3">
            <Alert variant="success">
              <AlertDescription>{result.message}</AlertDescription>
            </Alert>
            {result.devLink ? (
              <Alert variant="info">
                <AlertDescription>
                  Mode développement —{' '}
                  <Link
                    href={result.devLink.replace(/^https?:\/\/[^/]+/, '')}
                    className="break-all font-medium underline"
                  >
                    lien de réinitialisation
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Retour à la connexion</Link>
            </Button>
          </div>
        ) : (
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
                      <Input type="email" autoComplete="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
                Envoyer le lien
              </Button>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
