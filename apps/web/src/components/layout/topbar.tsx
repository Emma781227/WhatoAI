'use client';

import { Bell, Building2, Check, ChevronsUpDown, LogOut, Menu, Plus, Store, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOrganization } from '@/features/organizations/organization-provider';
import { useActiveShop } from '@/features/shops/shop-provider';
import { useAuth } from '@/lib/auth/auth-provider';
import { messages } from '@/lib/messages';

export function OrgSwitcher() {
  const { organizations, activeOrganization, switchOrganization } = useOrganization();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-56 justify-between gap-2 font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <Building2 aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{activeOrganization.organization.name}</span>
          </span>
          <ChevronsUpDown aria-hidden className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organisations</DropdownMenuLabel>
        {organizations.map((membership) => (
          <DropdownMenuItem
            key={membership.organization.id}
            onSelect={() => switchOrganization(membership.organization.id)}
          >
            <span className="flex-1 truncate">{membership.organization.name}</span>
            <span className="text-xs text-muted-foreground">{messages.roles[membership.role]}</span>
            {membership.organization.id === activeOrganization.organization.id ? (
              <Check aria-hidden className="h-4 w-4 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/organizations/new">
            <Plus aria-hidden />
            Nouvelle organisation
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ShopSwitcher() {
  const { shops, activeShop, switchShop } = useActiveShop();

  // Aucune Shop : les pages gèrent leur propre état vide, le sélecteur se tait.
  if (!activeShop) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="hidden max-w-48 justify-between gap-2 font-normal sm:flex">
          <span className="flex min-w-0 items-center gap-2">
            <Store aria-hidden className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{activeShop.name}</span>
          </span>
          <ChevronsUpDown aria-hidden className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Boutiques</DropdownMenuLabel>
        {shops.map((shop) => (
          <DropdownMenuItem key={shop.id} onSelect={() => switchShop(shop.id)}>
            <span className="flex-1 truncate">{shop.name}</span>
            {shop.isPrimary ? (
              <span className="text-xs text-muted-foreground">Principale</span>
            ) : null}
            {shop.id === activeShop.id ? <Check aria-hidden className="h-4 w-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const router = useRouter();

  if (!user) {
    return null;
  }
  const initials = `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Menu utilisateur"
        >
          <Avatar>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="truncate font-medium text-foreground">
            {user.firstName} {user.lastName}
          </div>
          <div className="truncate font-normal">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <User aria-hidden />
            Mon profil
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void logout().then(() => router.replace('/login'));
          }}
        >
          <LogOut aria-hidden />
          {messages.actions.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-card px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onToggleSidebar}
        aria-label="Ouvrir la navigation"
      >
        <Menu aria-hidden />
      </Button>
      <OrgSwitcher />
      <ShopSwitcher />
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            {/* Placeholder assumé : aucune notification réelle n'existe encore. */}
            <Button variant="ghost" size="icon" disabled aria-label="Notifications (bientôt disponible)">
              <Bell aria-hidden />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Notifications — bientôt disponible</TooltipContent>
      </Tooltip>
      <UserMenu />
    </header>
  );
}
