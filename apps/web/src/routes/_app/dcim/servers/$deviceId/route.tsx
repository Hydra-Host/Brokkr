import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { MapPin, Power, ScanSearch } from 'lucide-react';
import { useState } from 'react';

import type { Server } from '@repo/api-client';
import { DeviceStatusBadge } from '@repo/domain-ui/components/device-status-badge';
import {
  BootHeaderLine,
  HeaderLines,
  HealthHeaderLine,
  PhoneHomeHeaderLine,
} from '@repo/domain-ui/components/diagnostic-header-lines';
import { ResponsiveNavTabs } from '@repo/domain-ui/components/responsive-nav-tabs';
import { activeTab, tabHref, visibleTabs } from '@repo/domain-ui/hooks/server-tabs';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { TypewriterText } from '@repo/ui/components/typewriter-text';
import { useCanViewJobHistory } from '~/components/job-history-table';
import { RecentJobChip, type RecentJob } from '~/components/recent-job-chip';
import { useDcimDeviceEvents } from '~/hooks/use-device-events';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { HubDiagnosticsProvider } from '~/lib/diagnostics-api';
import { toDiagnosticDevice } from './-header-lines';
import { GATE_PASSES, SERVER_TABS } from './-server-tabs';

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
  const device = Route.useLoaderData();
  useDcimDeviceEvents(device.id);

  return (
    <HubDiagnosticsProvider>
      <div className="space-y-6">
        <ServerHeader device={device} />
        <Outlet />
      </div>
    </HubDiagnosticsProvider>
  );
}

function ServerHeader({ device }: { device: Server }) {
  const { can } = usePermissions();
  const { canView: canViewJobs } = useCanViewJobHistory();
  const diagnosticDevice = toDiagnosticDevice(device);
  const displayName = diagnosticDevice.displayName;
  const deviceId = device.id;
  const [recentJob, setRecentJob] = useState<RecentJob | null>(null);
  const { mutate: collectInventory, isPending: isCollecting } = tsr.collectServerInventory.useMutation({
    meta: { successMessage: 'Discovery collection started' },
    onSuccess: (response) => {
      if (response.status === 200)
        setRecentJob({ jobId: response.body.jobId, label: 'collection', startedAt: Date.now() });
    },
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const basePath = `/dcim/servers/${deviceId}`;
  const tabs = visibleTabs(SERVER_TABS, { canAccessJobLogs: can('job-log', 'access'), canViewJobs }, GATE_PASSES);
  const active = activeTab(pathname, basePath, tabs) ?? tabs[0];

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
              {device.zoneName || 'Unknown zone'}
            </Badge>
          </div>
          {device.dcim?.nickname && <p className="text-muted-foreground text-sm">{device.name}</p>}
          <HeaderLines
            device={diagnosticDevice}
            extra={
              <>
                <BootHeaderLine device={diagnosticDevice} />
                <HealthHeaderLine device={diagnosticDevice} />
                <PhoneHomeHeaderLine device={diagnosticDevice} />
              </>
            }
          />
        </div>

        <div className="flex flex-col items-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isCollecting}
            onClick={() => collectInventory({ params: { deviceId }, body: {} })}
          >
            <ScanSearch className="mr-2 h-4 w-4" />
            {isCollecting ? 'Collecting…' : 'Collect'}
          </Button>
          {recentJob && <RecentJobChip deviceId={deviceId} job={recentJob} />}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveNavTabs
          tabs={tabs.map((tab) => ({ name: tab.name, href: tabHref(basePath, tab) }))}
          activeValue={active ? tabHref(basePath, active) : ''}
        />
      </CardContent>
    </Card>
  );
}
