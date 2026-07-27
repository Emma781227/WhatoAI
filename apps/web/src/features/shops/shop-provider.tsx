'use client';

import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';

import { shopKeys, shopsApi, type Shop } from './api';

/**
 * Shop active de l'inbox — préférence UI UNIQUEMENT, par organisation
 * (aucune sécurité n'en dépend : le backend revalide le tenant à chaque
 * requête). Toujours revalidée contre la liste réelle des Shops non
 * archivées ; défaut = Shop principale, sinon première active, sinon première.
 */
function storageKey(organizationId: string): string {
  return `whauto:active-shop:${organizationId}`;
}

interface ShopContextValue {
  shops: Shop[];
  /** null = aucune Shop utilisable dans l'organisation (état vide géré par les pages). */
  activeShop: Shop | null;
  isLoading: boolean;
  switchShop: (shopId: string) => void;
}

const ShopContext = createContext<ShopContextValue | null>(null);

function readPreference(organizationId: string): string | null {
  try {
    return localStorage.getItem(storageKey(organizationId));
  } catch {
    return null;
  }
}

function writePreference(organizationId: string, shopId: string): void {
  try {
    localStorage.setItem(storageKey(organizationId), shopId);
  } catch {
    // Stockage indisponible : préférence perdue au rechargement, sans gravité.
  }
}

export function ShopProvider({ children }: { children: ReactNode }) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;

  const [preferredId, setPreferredId] = useState<string | null>(null);
  useEffect(() => {
    setPreferredId(readPreference(organizationId));
  }, [organizationId]);

  // Les archivées sont exclues par défaut par l'API.
  const shopsQuery = useQuery({
    queryKey: shopKeys.list(organizationId, { limit: 100 }),
    queryFn: () => shopsApi.list(organizationId, { limit: 100 }),
  });

  const shops = useMemo(() => shopsQuery.data?.items ?? [], [shopsQuery.data]);

  const activeShop = useMemo(() => {
    if (shops.length === 0) {
      return null;
    }
    return (
      shops.find((shop) => shop.id === preferredId) ??
      shops.find((shop) => shop.isPrimary) ??
      shops.find((shop) => shop.status === 'ACTIVE') ??
      shops[0]
    );
  }, [shops, preferredId]);

  const switchShop = useCallback(
    (shopId: string) => {
      writePreference(organizationId, shopId);
      setPreferredId(shopId);
    },
    [organizationId],
  );

  const value = useMemo(
    () => ({ shops, activeShop, isLoading: shopsQuery.isPending, switchShop }),
    [shops, activeShop, shopsQuery.isPending, switchShop],
  );

  return (
    <ShopContext.Provider value={value}>
      {/* key = shopId : démonte le sous-arbre au changement de Shop — aucune
          donnée de l'ancienne Shop ne flashe (pattern validé pour l'org). */}
      <div key={activeShop?.id ?? 'no-shop'} className="contents">
        {children}
      </div>
    </ShopContext.Provider>
  );
}

export function useActiveShop(): ShopContextValue {
  const context = useContext(ShopContext);
  if (!context) {
    throw new Error('useActiveShop doit être utilisé sous ShopProvider');
  }
  return context;
}
