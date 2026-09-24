import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { ColumnDef } from '@tanstack/react-table';
import { Check, Info, Loader2, X } from 'lucide-react';

import type { Deployment } from '@repo/api-client';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { DataTable, DataTableSortHeader } from '@repo/ui/components/data-table';
import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/components/tooltip';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { cn } from '@repo/ui/utils';
import { formatSize } from '@repo/utils';
import { DeploymentProgressCard } from '~/components/deployment-progress-card';
import { DeploymentSerialLogCard } from '~/components/deployment-serial-log-card';
import { DeviceDiagnosticsCard } from '~/components/device-diagnostics-card';
import { JobHistoryTable, useCanViewJobHistory } from '~/components/job-history-table';
import { tsr } from '~/lib/api';
import { COMPANY_NAME } from '~/lib/branding';
import { HubDeploymentDiagnosticsProvider } from '~/lib/diagnostics-api';
import { formatLegacyOsSlug } from '~/lib/format-os';
import { LIFECYCLE_JOBS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/')({
  staticData: { breadcrumb: 'Overview' },
  component: DeploymentOverviewPage,
});

const lifecycleColumns: ColumnDef<Deployment['lifecycleActions'][number]>[] = [
  {
    accessorKey: 'actionType',
    header: ({ column }) => <DataTableSortHeader column={column} label="Action Type" />,
    cell: ({ row }) => <JobTypeBadge jobType={row.original.actionType} />,
  },
  {
    id: 'performedBy',
    accessorFn: (row) => `${row.performedByName} ${row.performedByEmail}`,
    header: ({ column }) => <DataTableSortHeader column={column} label="Performed By" />,
    cell: ({ row }) => (
      <div className="flex flex-col gap-1">
        <span className="font-medium">{row.original.performedByName}</span>
        <span className="text-muted-foreground text-sm">{row.original.performedByEmail}</span>
      </div>
    ),
  },
  {
    accessorKey: 'performedAt',
    header: ({ column }) => <DataTableSortHeader column={column} label="Performed At" />,
    cell: ({ row }) => <span className="text-sm">{new Date(row.original.performedAt).toLocaleString()}</span>,
  },
  {
    accessorKey: 'source',
    header: ({ column }) => <DataTableSortHeader column={column} label="Source" />,
    cell: ({ row }) => <span className="text-sm">{row.original.source}</span>,
  },
];

function DeploymentOverviewPage() {
  const deployment = parentRoute.useLoaderData();
  return (
    <HubDeploymentDiagnosticsProvider deploymentId={deployment.id}>
      <DeploymentOverview />
    </HubDeploymentDiagnosticsProvider>
  );
}

function DeploymentOverview() {
  const deployment = parentRoute.useLoaderData();
  useDocumentTitle(deployment.customer?.deviceName ?? 'Deployment');

  const stats = [
    {
      name: 'Operating System',
      value:
        deployment.specs?.current_rescue_operating_system_name ||
        formatLegacyOsSlug(deployment.specs?.operating_system) ||
        '-',
      textColor: deployment.specs?.current_rescue_operating_system_name ? 'text-yellow-500' : undefined,
    },
    {
      name: 'Total Physical Cores',
      value: deployment.specs?.cpu?.totalCores,
    },
    {
      name: 'Total Storage',
      value: deployment.specs?.storage?.total,
      unit: 'GB',
    },
    ...(deployment.specs?.gpu?.count && deployment.specs.gpu.count > 0
      ? [{ name: 'GPU Count', value: deployment.specs.gpu.count }]
      : []),
    {
      name: 'Total Memory',
      value: deployment.specs?.memory?.total,
      unit: 'GB',
    },
  ];

  const username = (() => {
    if (deployment.specs?.current_rescue_operating_system_name) return 'root';
    const os = deployment.specs?.operating_system?.toLowerCase() || '';
    if (os.includes('ubuntu')) return 'ubuntu';
    if (os.includes('debian')) return 'debian';
    return 'username';
  })();

  const sshCommand = `ssh ${username}@${deployment.networking?.ipv4 || deployment.networking?.ipv6}`;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'grid grid-cols-1 gap-4 sm:grid-cols-2',
          stats.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3 xl:grid-cols-5',
        )}
      >
        {stats.map((stat) => (
          <Card key={stat.name} className="py-4">
            <CardContent>
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm font-medium">{stat.name}</p>
                <div className="flex items-baseline gap-2">
                  <span className={cn('text-2xl font-bold tracking-tight', stat.textColor)}>{stat.value}</span>
                  {stat.unit && <span className="text-muted-foreground text-sm">{stat.unit}</span>}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <PendingLifecycleRequests deployment={deployment} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Specifications</CardTitle>
            <CardDescription>The details of the hardware in this deployment</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-6 sm:flex-row">
                <SpecSection title="CPU">
                  <SpecRow label="Model" value={deployment.specs?.cpu?.model || '-'} />
                  <SpecRow label="Cores" value={deployment.specs?.cpu?.totalCores || '-'} />
                  <SpecRow label="Threads" value={deployment.specs?.cpu?.totalThreads || '-'} />
                  <SpecRow label="Quantity" value={deployment.specs?.cpu?.count || '-'} />
                </SpecSection>
                {deployment.specs?.gpu?.count > 0 && (
                  <>
                    <div className="border-border-dim sm:border-l" />
                    <SpecSection title="GPU">
                      <SpecRow label="Model" value={deployment.specs.gpu.model || '-'} />
                      <SpecRow label="Quantity" value={deployment.specs.gpu.count} />
                    </SpecSection>
                  </>
                )}
              </div>

              <div className="border-border-dim border-t" />

              <div className="flex flex-col gap-6 sm:flex-row">
                <SpecSection title="Storage">
                  {deployment.specs?.storage?.nvmeCount > 0 && (
                    <SpecRow
                      label={`NVMe (x${deployment.specs.storage.nvmeCount})`}
                      value={
                        formatSize(deployment.specs.storage.nvmeSize / deployment.specs.storage.nvmeCount, 'GB', 2) ||
                        '-'
                      }
                    />
                  )}
                  {deployment.specs?.storage?.ssdCount > 0 && (
                    <SpecRow
                      label={`SSD (x${deployment.specs.storage.ssdCount})`}
                      value={
                        formatSize(deployment.specs.storage.ssdSize / deployment.specs.storage.ssdCount, 'GB', 2) || '-'
                      }
                    />
                  )}
                  {deployment.specs?.storage?.hddCount > 0 && (
                    <SpecRow
                      label={`HDD (x${deployment.specs.storage.hddCount})`}
                      value={
                        formatSize(deployment.specs.storage.hddSize / deployment.specs.storage.hddCount, 'GB', 2) || '-'
                      }
                    />
                  )}
                  <SpecRow label="Total Storage" value={formatSize(deployment.specs?.storage?.total, 'GB', 2) || '-'} />
                </SpecSection>
                <div className="border-border-dim sm:border-l" />
                <SpecSection title="Memory">
                  <SpecRow label="Total RAM" value={formatSize(deployment.specs?.memory?.total, 'GB', 2) || '-'} />
                </SpecSection>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Connection Information</CardTitle>
            <CardDescription>Access your device with the SSH keys you provisioned with</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6">
              <SpecSection title="IP Addresses">
                {deployment.networking?.ipv4 && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted-foreground text-sm">IPv4</span>
                    <ClickToCopyString value={deployment.networking.ipv4} />
                  </div>
                )}
                {deployment.networking?.ipv6 && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted-foreground text-sm">IPv6</span>
                    <ClickToCopyString value={deployment.networking.ipv6} truncate />
                  </div>
                )}
              </SpecSection>

              {deployment.sshKeys && deployment.sshKeys.length > 0 && (
                <>
                  <div className="border-border-dim border-t" />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-1">
                      <h3 className="text-base font-medium">SSH Keys</h3>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <Info className="text-muted-foreground h-3.5 w-3.5" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p>
                              These are the SSH keys used during initial setup. Additional keys may have been added
                              after provisioning.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <div className="flex flex-col gap-1">
                      {deployment.sshKeys.map((sshKey) => (
                        <div key={sshKey.id} className="flex items-center justify-between py-1">
                          <div className="flex items-center gap-2">
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-xs">{sshKey.user?.firstName?.[0] || '?'}</AvatarFallback>
                            </Avatar>
                            <span className="text-muted-foreground truncate text-sm">
                              {sshKey.user?.firstName} {sshKey.user?.lastName}
                            </span>
                          </div>
                          <span className="truncate text-sm">{sshKey.name || 'SSH Key'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="border-border-dim border-t" />
              <SpecSection title="SSH Command">
                <div className="bg-muted rounded-md p-3">
                  <code className="font-mono text-sm">
                    <ClickToCopyString value={sshCommand} />
                  </code>
                </div>
              </SpecSection>
            </div>
          </CardContent>
        </Card>
      </div>

      {deployment.lifecycleActions && deployment.lifecycleActions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Lifecycle Actions</CardTitle>
            <CardDescription>
              A complete history of all power state changes, provisioning events, and administrative actions performed
              on this deployment
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={lifecycleColumns}
              data={deployment.lifecycleActions}
              emptyMessage="No lifecycle actions recorded"
            />
          </CardContent>
        </Card>
      )}

      <CustomerProvisioningProgress deployment={deployment} />
      <DeploymentJobHistory deployment={deployment} />
      <DeploymentSerialLogCard deploymentId={deployment.id} />

      {deployment.deviceDiagnostics && deployment.deviceDiagnostics.length > 0 && (
        <DeviceDiagnosticsCard diagnostics={deployment.deviceDiagnostics} />
      )}
    </div>
  );
}

// the operator's Job History card below shows the same jobs in full, so the card is for viewers without it
function CustomerProvisioningProgress({ deployment }: { deployment: Deployment }) {
  const { canView, isPending } = useCanViewJobHistory();

  if (isPending || canView) return null;

  return <DeploymentProgressCard deploymentId={deployment.id} />;
}

function DeploymentJobHistory({ deployment }: { deployment: Deployment }) {
  const { canView, isPending } = useCanViewJobHistory();

  if (isPending || !canView) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job History</CardTitle>
        <CardDescription>Lifecycle jobs for this deployment with their job IDs.</CardDescription>
      </CardHeader>
      <CardContent>
        <JobHistoryTable deploymentId={deployment.id} tableName={`deployment-jobs-${deployment.id}`} />
      </CardContent>
    </Card>
  );
}

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'default',
  APPROVED: 'secondary',
  REJECTED: 'destructive',
  EXECUTED: 'outline',
};

function PendingLifecycleRequests({ deployment }: { deployment: Deployment }) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { mutateAsync: approve, isPending: isApproving } = tsr.approveLifecycleRequest.useMutation({
    meta: { successMessage: 'Lifecycle request approved' },
  });

  const { mutateAsync: reject, isPending: isRejecting } = tsr.rejectLifecycleRequest.useMutation({
    meta: { successMessage: 'Lifecycle request rejected' },
  });

  const pendingRequests = deployment.lifecycleRequests?.filter((r) => r.status === 'PENDING') ?? [];

  if (pendingRequests.length === 0) return null;

  const handleApprove = async (requestId: string) => {
    await approve({ params: { id: deployment.id, requestId }, body: {} });
    queryClient.removeQueries({ queryKey: ['deployment', deployment.id] });
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_JOBS_KEY });
    await router.invalidate();
  };

  const handleReject = async (requestId: string) => {
    await reject({ params: { id: deployment.id, requestId }, body: {} });
    queryClient.removeQueries({ queryKey: ['deployment', deployment.id] });
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_JOBS_KEY });
    await router.invalidate();
  };

  return (
    <Card className="[--card-border-color:var(--color-amber-500)]">
      <CardHeader>
        <CardTitle>Pending Lifecycle Requests</CardTitle>
        <CardDescription>
          A {COMPANY_NAME} administrator has requested approval for the following actions on this deployment
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingRequests.map((request) => (
          <Alert key={request.id}>
            <AlertTitle className="flex items-center gap-2">
              <Badge variant={statusVariant[request.status]}>{request.type}</Badge>
              requested by {request.requestedByName ?? 'Admin'}
            </AlertTitle>
            <AlertDescription className="mt-2 space-y-2">
              {typeof request.requestBody.notes === 'string' && request.requestBody.notes.length > 0 && (
                <p className="text-sm">{request.requestBody.notes}</p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">
                  Created {new Date(request.createdAt).toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleReject(request.id)}
                    disabled={isApproving || isRejecting}
                  >
                    {isRejecting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <X className="mr-1 h-3 w-3" />}
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleApprove(request.id)} disabled={isApproving || isRejecting}>
                    {isApproving ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-3 w-3" />
                    )}
                    Approve
                  </Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        ))}
      </CardContent>
    </Card>
  );
}

function SpecRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function SpecSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-base font-medium">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
