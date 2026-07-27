'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/forms/password-input';
import { ApiError, getErrorMessage } from '@/lib/api/api-error';

import { authApi } from '../api';
import { registerSchema, type RegisterValues } from '../schemas';

export function RegisterForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; devLink?: string } | null>(null);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
  });

  async function onSubmit(values: RegisterValues) {
    setFormError(null);
    try {
      setResult(await authApi.register(values));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'EMAIL_ALREADY_USED') {
        form.setError('email', { message: 'Un compte actif existe déjà avec cet email.' });
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MailCheck aria-hidden className="h-5 w-5 text-primary" />
            Vérifiez votre boîte mail
          </CardTitle>
          <CardDescription>
            Un lien de vérification a été envoyé à votre adresse. Ouvrez-le pour activer votre compte,
            puis connectez-vous.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.devLink ? (
            <Alert variant="info">
              <AlertDescription>
                Mode développement — lien de vérification :{' '}
                <Link
                  href={result.devLink.replace(/^https?:\/\/[^/]+/, '')}
                  className="break-all font-medium underline"
                >
                  ouvrir le lien
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <Button asChild className="w-full">
            <Link href="/login">Aller à la connexion</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Créer un compte</CardTitle>
        <CardDescription>Lancez votre commerce conversationnel WhatsApp</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {formError ? (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prénom</FormLabel>
                    <FormControl>
                      <Input autoComplete="given-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nom</FormLabel>
                    <FormControl>
                      <Input autoComplete="family-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="email" placeholder="vous@entreprise.cm" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mot de passe</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              Créer un compte
            </Button>
          </form>
        </Form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Déjà inscrit ?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Se connecter
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
