'use client';

import {
  Bot,
  Boxes,
  Contact,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Package,
  Settings,
  ShoppingCart,
  Store,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  comingSoon?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: messages.nav.dashboard, href: '/dashboard', icon: LayoutDashboard },
  { label: messages.nav.conversations, href: '/conversations', icon: MessagesSquare },
  { label: messages.nav.contacts, href: '/contacts', icon: Contact },
  { label: messages.nav.products, href: '/products', icon: Package },
  { label: 'Inventaire', href: '/inventory', icon: Boxes },
  { label: messages.nav.orders, href: '/orders', icon: ShoppingCart },
  { label: messages.nav.automations, icon: Workflow, comingSoon: true },
  { label: messages.nav.aiAgent, icon: Bot, comingSoon: true },
  { label: messages.nav.shops, href: '/shops', icon: Store },
  { label: messages.nav.members, href: '/members', icon: Users },
  { label: messages.nav.settings, href: '/organizations', icon: Settings },
];

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navigation principale" className="flex flex-1 flex-col gap-0.5 px-3 py-4">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        if (item.comingSoon || !item.href) {
          return (
            <span
              key={item.label}
              aria-disabled="true"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/60"
            >
              <Icon aria-hidden className="h-4 w-4" />
              <span className="flex-1">{item.label}</span>
              <Badge variant="muted" className="text-[10px]">
                {messages.nav.comingSoon}
              </Badge>
            </span>
          );
        }
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.label}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary-subtle text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-border px-4">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <MessageSquare aria-hidden className="h-4 w-4" />
      </span>
      <span className="font-heading text-base font-bold">{messages.app.name}</span>
    </div>
  );
}
