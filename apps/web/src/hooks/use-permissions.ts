import { useMemo } from 'react';

import { useSession } from '@repo/auth/client';
import { tsr } from '~/lib/api';

export function usePermissions(): {
  permissions: Set<string>;
  can: (resource: string, action: string) => boolean;
  isLoading: boolean;
} {
  const { data: session, isPending: isSessionPending } = useSession();
  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId;

  const { data: organizationsData, isPending: isOrganizationsPending } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const activeOrg = organizationsData?.body?.data?.find((o) => o.id === activeOrgId);
  const isLoading = isSessionPending || isOrganizationsPending;

  return useMemo(() => {
    const permissions = new Set(activeOrg?.permissions ?? []);
    return {
      permissions,
      can: (resource: string, action: string) => permissions.has(`${resource}:${action}`),
      isLoading,
    };
  }, [activeOrg?.permissions, isLoading]);
}
