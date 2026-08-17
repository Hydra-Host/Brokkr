import { createFileRoute, Outlet } from '@tanstack/react-router';
import {
  AlertTriangle,
  Eye,
  FileCode2,
  FlaskConical,
  KeyRound,
  Mail,
  MapPin,
  Network,
  Power,
  ScanSearch,
  Settings,
} from 'lucide-react';

import type { Server } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { ButtonLink } from '@repo/ui/components/button-link';
import { Card, CardHeader, CardTitle } from '@repo/ui/components/card';
import { DeviceStatusBadge } from '@repo/ui/components/device-status-badge';
import { Skeleton } from '@repo/ui/components/skeleton';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { useDcimDeviceEvents } from '~/hooks/use-device-events';
import { tsr } from '~/lib/api';

const serverQueryKey = (deviceId: string) => ['server', deviceId] as const;

export const Route = createFileRoute('/_app/dcim/servers/$deviceId')({
  staticData: {
    breadcrumb: (data) => {
      const device = data as Server;
      return device?.dcim?.nickname || device?.name || 'Server';
    },
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: serverQueryKey(params.deviceId),
      queryFn: () =>
        tsr.getServerById.query({
          params: { deviceId: params.deviceId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load server');
    }

    return response.body;
  },
  component: ServerLayout,
  pendingComponent: ServerLayoutSkeleton,
});

function ServerLayoutSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-3">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-32" />
          </div>
        </CardHeader>
      </Card>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function ServerLayout() {
  const device = Route.useLoaderData() as Server;
  useDcimDeviceEvents(device.id);

  return (
    <div className="space-y-6">
      <ServerHeader device={device} />
      <Outlet />
    </div>
  );
}

function ServerHeader({ device }: { device: Server }) {
  const displayName = device.dcim?.nickname || device.name;
  const deviceId = device.id;
  const { mutate: collectInventory, isPending: isCollecting } = tsr.collectServerInventory.useMutation({
    meta: { successMessage: 'Discovery collection started' },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 space-x-8">
        <div className="space-y-2">
          <CardTitle className="text-2xl">
            <TypewriterText text={displayName} />
          </CardTitle>
          <div className="flex items-center gap-2">
            {device.status?.label && <DeviceStatusBadge status={device.status.label} />}
            {device.powerStatus?.label && <DeviceStatusBadge status={device.powerStatus.label} icon={Power} />}
            <Badge variant="secondary" className="h-6 px-2">
              <MapPin className="mr-1.5 h-3 w-3" />
              {device.zoneName || 'Unknown data center'}
            </Badge>
          </div>
          {device.dcim?.nickname && <p className="text-muted-foreground text-sm">{device.name}</p>}
          <p className="text-muted-foreground text-sm">ID: {device.id}</p>
        </div>

        <div className="grid grid-cols-4 gap-2">
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId" params={{ deviceId }}>
            <Eye className="mr-2 h-4 w-4" />
            Overview
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/interfaces" params={{ deviceId }}>
            <Network className="mr-2 h-4 w-4" />
            Interfaces
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/netplan" params={{ deviceId }}>
            <FileCode2 className="mr-2 h-4 w-4" />
            Netplan
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/settings" params={{ deviceId }}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/bmc-secrets" params={{ deviceId }}>
            <KeyRound className="mr-2 h-4 w-4" />
            BMC Secrets
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/provision" params={{ deviceId }}>
            <Power className="mr-2 h-4 w-4" />
            Provision
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/invite" params={{ deviceId }}>
            <Mail className="mr-2 h-4 w-4" />
            Invite
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/test-runs" params={{ deviceId }}>
            <FlaskConical className="mr-2 h-4 w-4" />
            Test Runs
          </ButtonLink>
          <ButtonLink variant="outline" size="sm" to="/dcim/servers/$deviceId/decommission" params={{ deviceId }}>
            <AlertTriangle className="mr-2 h-4 w-4" />
            Decommission
          </ButtonLink>
          <Button
            variant="outline"
            size="sm"
            disabled={isCollecting}
            onClick={() => collectInventory({ params: { deviceId }, body: {} })}
          >
            <ScanSearch className="mr-2 h-4 w-4" />
            {isCollecting ? 'Collecting…' : 'Collect'}
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
}
