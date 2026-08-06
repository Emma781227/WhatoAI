'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOrganization } from '@/features/organizations/organization-provider';
import { getSocket, useSocketConnection } from '@/lib/socket/socket-provider';

import { TERMINAL_TOPUP_STATUSES, walletApi, walletKeys, type PageQuery, type TopUp } from './api';

const WALLET_EVENTS = ['wallet.balance.updated', 'wallet.insufficient'] as const;

/**
 * Solde du Wallet. La source de vérité reste l'API : le socket ne fait
 * qu'invalider (jamais de solde poussé appliqué en aveugle). Réconciliation à
 * chaque (re)connexion via connectionEpoch. Utilisé pour la page crédits ET la
 * garde aiAvailable de l'inbox.
 */
export function useWallet() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  const { connectionEpoch } = useSocketConnection();

  const query = useQuery({
    queryKey: walletKeys.balance(organizationId),
    queryFn: () => walletApi.getBalance(organizationId),
    staleTime: 15_000,
  });

  // Réconciliation à la (re)connexion socket.
  useEffect(() => {
    if (connectionEpoch > 0) {
      void queryClient.invalidateQueries({ queryKey: walletKeys.balance(organizationId) });
    }
  }, [connectionEpoch, organizationId, queryClient]);

  useEffect(() => {
    const socket = getSocket();
    const onWalletEvent = (payload: { organizationId?: string }) => {
      if (payload?.organizationId && payload.organizationId !== organizationId) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: walletKeys.balance(organizationId) });
    };
    for (const event of WALLET_EVENTS) {
      socket.on(event, onWalletEvent);
    }
    return () => {
      for (const event of WALLET_EVENTS) {
        socket.off(event, onWalletEvent);
      }
    };
  }, [organizationId, queryClient]);

  return query;
}

export function useWalletTransactions(params: PageQuery, enabled = true) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  return useQuery({
    queryKey: walletKeys.transactions(organizationId, params),
    queryFn: () => walletApi.listTransactions(organizationId, params),
    enabled,
  });
}

export function useWalletUsage(params: PageQuery, enabled = true) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  return useQuery({
    queryKey: walletKeys.usage(organizationId, params),
    queryFn: () => walletApi.listUsage(organizationId, params),
    enabled,
  });
}

export function useCreditPackages(enabled = true) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  return useQuery({
    queryKey: walletKeys.packages(organizationId),
    queryFn: () => walletApi.listPackages(organizationId),
    enabled,
    staleTime: 300_000,
  });
}

export function useTopUps(params: PageQuery, enabled = true) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  return useQuery({
    queryKey: walletKeys.topUps(organizationId, params),
    queryFn: () => walletApi.listTopUps(organizationId, params),
    enabled,
  });
}

/**
 * Suit une recharge par POLLING de `GET top-up` jusqu'à un statut TERMINAL. Le
 * frontend ne confirme JAMAIS un paiement : il n'affiche que ce que le backend
 * (webhook Genius Pay vérifié) a tranché. Le polling s'arrête dès qu'un statut
 * terminal est atteint. La mise à jour du solde arrive aussi via `wallet.balance.updated`.
 */
export function useTopUp(topUpId: string | null) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  return useQuery({
    queryKey: walletKeys.topUp(organizationId, topUpId ?? 'none'),
    queryFn: () => walletApi.getTopUp(organizationId, topUpId as string),
    enabled: topUpId !== null,
    refetchInterval: (query) => {
      const status = (query.state.data as TopUp | undefined)?.status;
      return status && TERMINAL_TOPUP_STATUSES.includes(status) ? false : 3000;
    },
  });
}

export function useCreateTopUp() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (creditPackageId: string) => walletApi.createTopUp(organizationId, creditPackageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: walletKeys.all(organizationId) });
    },
  });
}

export function useMockConfirmTopUp() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (topUpId: string) => walletApi.mockConfirm(organizationId, topUpId),
    onSuccess: () => {
      // Le solde ET les historiques changent après un crédit.
      void queryClient.invalidateQueries({ queryKey: walletKeys.all(organizationId) });
    },
  });
}
