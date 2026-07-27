'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ErrorState } from '@/components/feedback/error-state';
import { AuthSplash } from '@/lib/auth/require-auth';

import { organizationKeys, organizationsApi, type OrganizationMembership } from './api';

/**
 * Préférence d'interface UNIQUEMENT (l'organizationId n'est pas un secret et
 * aucune sécurité n'en dépend : le backend revalide le Membership à chaque
 * requête). Toujours revalidée contre GET /organizations.
 */
const ACTIVE_ORG_STORAGE_KEY = 'whauto:active-org';

interface OrganizationContextValue {
  organizations: OrganizationMembership[];
  activeOrganization: OrganizationMembership;
  /** True pendant un changement d'organisation : les pages masquent leurs données. */
  isSwitching: boolean;
  switchOrganization: (organizationId: string) => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

function readPreference(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePreference(organizationId: string): void {
  try {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, organizationId);
  } catch {
    // Stockage indisponible : la préférence est simplement perdue au rechargement.
  }
}

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  useEffect(() => {
    setPreferredId(readPreference());
    setPreferenceLoaded(true);
  }, []);

  const organizationsQuery = useQuery({
    queryKey: organizationKeys.list(),
    queryFn: () => organizationsApi.list(),
  });

  const organizations = useMemo(
    () => organizationsQuery.data ?? [],
    [organizationsQuery.data],
  );

  // Préférence revalidée contre la liste réelle ; sinon première organisation.
  const activeOrganization = useMemo(() => {
    if (organizations.length === 0) {
      return null;
    }
    return (
      organizations.find((membership) => membership.organization.id === preferredId) ??
      organizations[0]
    );
  }, [organizations, preferredId]);

  // Aucune organisation : redirection vers l'onboarding.
  useEffect(() => {
    if (preferenceLoaded && organizationsQuery.isSuccess && organizations.length === 0) {
      router.replace('/onboarding');
    }
  }, [preferenceLoaded, organizationsQuery.isSuccess, organizations.length, router]);

  const switchOrganization = useCallback(
    (organizationId: string) => {
      if (organizationId === activeOrganization?.organization.id) {
        return;
      }
      // État de transition : évite tout flash de données de l'ancien tenant.
      // Les query keys étant scoppées par organizationId, aucune donnée de
      // l'ancienne organisation ne peut être servie à la nouvelle.
      setIsSwitching(true);
      writePreference(organizationId);
      setPreferredId(organizationId);
      // Radix ferme ses dialogues au démontage ; le remount via `key` (voir
      // ci-dessous) réinitialise toutes les sélections dépendantes.
      requestAnimationFrame(() => setIsSwitching(false));
    },
    [activeOrganization],
  );

  if (!preferenceLoaded || organizationsQuery.isPending) {
    return <AuthSplash />;
  }
  if (organizationsQuery.isError) {
    return (
      <div className="p-8">
        <ErrorState error={organizationsQuery.error} onRetry={() => void organizationsQuery.refetch()} />
      </div>
    );
  }
  if (!activeOrganization) {
    return <AuthSplash />; // Redirection onboarding en cours.
  }

  return (
    <OrganizationContext.Provider
      value={{ organizations, activeOrganization, isSwitching, switchOrganization }}
    >
      {/* key = orgId : démonte tout l'arbre au changement d'organisation —
          ferme dialogues et réinitialise les états locaux de l'ancien tenant. */}
      <div key={activeOrganization.organization.id} className="contents">
        {isSwitching ? <AuthSplash /> : children}
      </div>
    </OrganizationContext.Provider>
  );
}

export function useOrganization(): OrganizationContextValue {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error('useOrganization doit être utilisé sous OrganizationProvider');
  }
  return context;
}
