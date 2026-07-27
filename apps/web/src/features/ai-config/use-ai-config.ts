'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useOrganization } from '@/features/organizations/organization-provider';

import { aiConfigApi, aiConfigKeys, type UpdateAiConfigurationInput } from './api';

/** Configuration IA d'une Shop (lecture — AI_READ suffit, tous les rôles). */
export function useAiConfig(shopId: string | null, enabled = true) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;

  return useQuery({
    queryKey: aiConfigKeys.detail(organizationId, shopId ?? 'none'),
    queryFn: () => aiConfigApi.get(organizationId, shopId as string),
    enabled: enabled && shopId !== null,
  });
}

export function useUpdateAiConfig(shopId: string) {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateAiConfigurationInput) =>
      aiConfigApi.update(organizationId, shopId, input),
    onSuccess: (config) => {
      queryClient.setQueryData(aiConfigKeys.detail(organizationId, shopId), config);
    },
  });
}
