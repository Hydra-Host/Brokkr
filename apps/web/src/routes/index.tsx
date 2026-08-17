import { useSession } from '@repo/auth/client';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { tsr } from '~/lib/api';
import { getLandingRoute } from '~/lib/landing-route';

export const Route = createFileRoute('/')({
  component: IndexRedirect,
});

function IndexRedirect() {
  const { data: session, isPending: sessionPending } = useSession();
  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId;

  const { data: organizations, isPending: orgsPending } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
    enabled: !!session,
  });

  const orgsList = organizations?.body?.data;
  const fallbackOrg = orgsList?.find((org) => org.isDefaultOrg) ?? orgsList?.[0];
  const activeOrg = orgsList?.find((org) => org.id === activeOrgId) ?? fallbackOrg;

  if (sessionPending || (session && orgsPending)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/inventory" />;
  }

  return <Navigate to={getLandingRoute(activeOrg?.tenantType)} />;
}
