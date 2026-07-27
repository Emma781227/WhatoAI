'use client';

import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { SidebarBrand, SidebarNav } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen">
        {/* Sidebar desktop fixe */}
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-card lg:flex">
          <SidebarBrand />
          <SidebarNav />
        </aside>

        {/* Sidebar mobile (drawer) */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button
              className="absolute inset-0 bg-foreground/40"
              onClick={() => setMobileOpen(false)}
              aria-label="Fermer la navigation"
            />
            <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-card shadow-popover">
              <div className="flex items-center justify-between border-b border-border pr-2">
                <SidebarBrand />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Fermer la navigation"
                >
                  <X aria-hidden />
                </Button>
              </div>
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
          <Topbar onToggleSidebar={() => setMobileOpen(true)} />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
