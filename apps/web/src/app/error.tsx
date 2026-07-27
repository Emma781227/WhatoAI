'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  // Le détail technique n'est jamais affiché — uniquement un message public.
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <AlertTriangle aria-hidden className="h-10 w-10 text-destructive" />
      <h1 className="text-xl">Une erreur est survenue</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Quelque chose s’est mal passé. Vous pouvez réessayer.
      </p>
      <Button onClick={reset}>Réessayer</Button>
    </div>
  );
}
