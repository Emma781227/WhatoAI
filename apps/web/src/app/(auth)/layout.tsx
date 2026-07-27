import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { messages } from '@/lib/messages';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2 text-lg font-bold">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageSquare aria-hidden className="h-4 w-4" />
        </span>
        {messages.app.name}
      </Link>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
