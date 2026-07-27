'use client';

import { Suspense, type ReactNode } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { OrganizationProvider } from '@/features/organizations/organization-provider';
import { ShopProvider } from '@/features/shops/shop-provider';
import { AuthSplash, RequireAuth } from '@/lib/auth/require-auth';
import { SocketProvider } from '@/lib/socket/socket-provider';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AuthSplash />}>
      <RequireAuth>
        <OrganizationProvider>
          <SocketProvider>
            <ShopProvider>
              <AppShell>{children}</AppShell>
            </ShopProvider>
          </SocketProvider>
        </OrganizationProvider>
      </RequireAuth>
    </Suspense>
  );
}
