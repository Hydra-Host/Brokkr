import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Crown, Warehouse } from 'lucide-react';

import type { BridgeResponse } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { ButtonLink } from '@repo/ui/components/button-link';
import { Card, CardHeader, CardTitle } from '@repo/ui/components/card';

import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { capitalizeFirstLetter, getBridgeStatusBadgeVariant, getBridgeTypeBadgeVariant } from '@repo/utils/format';
import { tsr } from '~/lib/api';

const bridgeQueryKey = (bridgeId: string) => ['bridge', bridgeId] as const;

export const Route = createFileRoute('/_app/dcim/bridges/$bridgeId')({
  staticData: {
    breadcrumb: (data) => (data as BridgeResponse)?.name ?? 'Bridge',
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: bridgeQueryKey(params.bridgeId),
      queryFn: () =>
        tsr.getBridgeById.query({
          params: { bridgeId: params.bridgeId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load bridge');
    }

    return response.body;
  },
  component: BridgeLayout,
});

function BridgeLayout() {
  const bridge = Route.useLoaderData() as BridgeResponse;
  const { bridgeId } = Route.useParams();

  return (
    <div className="space-y-6">
      <BridgeHeader bridge={bridge} />
      <div className="flex flex-wrap gap-2">
        <ButtonLink variant="outline" size="sm" to="/dcim/bridges/$bridgeId" params={{ bridgeId }}>
          Overview
        </ButtonLink>
        <ButtonLink variant="outline" size="sm" to="/dcim/bridges/$bridgeId/interfaces" params={{ bridgeId }}>
          Interfaces
        </ButtonLink>
        <ButtonLink variant="outline" size="sm" to="/dcim/bridges/$bridgeId/netplan" params={{ bridgeId }}>
          Netplan
        </ButtonLink>
      </div>
      <Outlet />
    </div>
  );
}

function BridgeHeader({ bridge }: { bridge: BridgeResponse }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-2">
          <CardTitle className="text-2xl">
            <TypewriterText text={bridge.name} />
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={bridge.online ? 'success' : 'destructive'}>{bridge.online ? 'Online' : 'Offline'}</Badge>

            {bridge.is_leader && (
              <Badge variant="info" className="gap-1">
                <Crown className="h-3 w-3" />
                Leader
              </Badge>
            )}

            {bridge.status && (
              <Badge variant={getBridgeStatusBadgeVariant(bridge.status)}>{capitalizeFirstLetter(bridge.status)}</Badge>
            )}

            {bridge.type && (
              <Badge variant={getBridgeTypeBadgeVariant(bridge.type)}>{capitalizeFirstLetter(bridge.type)}</Badge>
            )}

            {bridge.zone?.name &&
              (bridge.zone.id ? (
                <Link to="/dcim/zones/$zoneId" params={{ zoneId: bridge.zone.id }}>
                  <Badge variant="secondary" className="hover:text-primary h-6 px-2">
                    <Warehouse className="mr-1.5 h-3 w-3" />
                    {bridge.zone.name}
                  </Badge>
                </Link>
              ) : (
                <Badge variant="secondary" className="h-6 px-2">
                  <Warehouse className="mr-1.5 h-3 w-3" />
                  {bridge.zone.name}
                </Badge>
              ))}
          </div>
          <p className="text-muted-foreground text-sm">ID: {bridge.id}</p>
        </div>
      </CardHeader>
    </Card>
  );
}
