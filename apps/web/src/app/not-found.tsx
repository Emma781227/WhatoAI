import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <p className="font-heading text-6xl font-bold text-primary">404</p>
      <h1 className="text-xl">Page introuvable</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        La page demandée n’existe pas ou a été déplacée.
      </p>
      <Button asChild>
        <Link href="/dashboard">Retour au tableau de bord</Link>
      </Button>
    </div>
  );
}
