import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ExternalLink, Info, MapPin, MoveUpRight, Power } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import type { Deployment } from '@repo/api-client';
import { DeviceStatusBadge } from '@repo/domain-ui/components/device-status-badge';
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { Separator } from '@repo/ui/components/separator';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/components/tooltip';
import { cn, navigatePreservingSearch } from '@repo/ui/utils';
import { formatSize } from '@repo/utils';
import { tsr } from '~/lib/api';
import { formatLegacyOsSlug } from '~/lib/format-os';

const searchSchema = z.object({
  deploymentId: z.string(),
  project: z.string().optional(),
});

export const Route = createFileRoute('/_app/deployments/_list/deployment-details')({
  validateSearch: searchSchema,
  component: DeploymentDetailsSheet,
});

const ANIMATION_DURATION = 300;

function DeploymentDetailsSheet() {
  const { deploymentId, project: projectId } = Route.useSearch();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(true);
  }, []);

  const closeSheet = () => {
    setOpen(false);
    setTimeout(
      () =>
        navigatePreservingSearch(navigate, {
          to: '/deployments',
          search: (prev) => {
            return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== 'deploymentId'));
          },
        }),
      ANIMATION_DURATION,
    );
  };

  const { data, isPending } = tsr.getDeploymentById.useQuery({
    queryKey: ['deployment', deploymentId],
    queryData: { params: { id: deploymentId } },
  });

  const deployment = data?.status === 200 ? data.body : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) closeSheet();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[50vw]">
        {isPending ? (
          <DeploymentDetailsSkeleton />
        ) : deployment ? (
          <DeploymentDetailContent deployment={deployment} projectId={projectId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">Deployment not found.</p>
          </div>
        )}

        <SheetFooter className="mt-6">
          <Button variant="outline" onClick={closeSheet}>
            Close
          </Button>
          {deployment && (
            <Button asChild>
              <Link to="/deployments/$deploymentId" params={{ deploymentId }}>
                <ExternalLink className="mr-2 h-4 w-4" />
                View Full Deployment
              </Link>
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DeploymentDetailsSkeleton() {
  return (
    <>
      <SheetHeader>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-64" />
      </SheetHeader>
      <div className="mt-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </>
  );
}

function DeploymentDetailContent({ deployment, projectId }: { deployment: Deployment; projectId?: string }) {
  const deploymentId = String(deployment.id);

  const username = (() => {
    if (deployment.specs?.current_rescue_operating_system_name) return 'root';
    const os = deployment.specs?.operating_system?.toLowerCase() || '';
    if (os.includes('ubuntu')) return 'ubuntu';
    if (os.includes('debian')) return 'debian';
    return 'username';
  })();

  const hasNetworking = deployment.networking?.ipv4 || deployment.networking?.ipv6;
  const sshCommand = hasNetworking
    ? `ssh ${username}@${deployment.networking?.ipv4 || deployment.networking?.ipv6}`
    : null;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-xl">{deployment.customer?.deviceName || 'Deployment'}</SheetTitle>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <DeviceStatusBadge status={deployment.status?.label ?? ''} />
          <DeviceStatusBadge status={deployment.powerStatus?.label || ''} icon={Power} />
          {deployment.location && (
            <Badge variant="secondary">
              <MapPin className="mr-1 h-3 w-3" />
              {deployment.location}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground pt-1 font-mono text-xs">ID: {deployment.id}</p>
      </SheetHeader>

      <div className="mt-6 space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatItem
            label="OS"
            value={
              deployment.specs?.current_rescue_operating_system_name ||
              formatLegacyOsSlug(deployment.specs?.operating_system) ||
              '-'
            }
            highlight={!!deployment.specs?.current_rescue_operating_system_name}
          />
          <StatItem label="CPU Cores" value={deployment.specs?.cpu?.totalCores ?? '-'} />
          {deployment.specs?.gpu?.count > 0 && (
            <StatItem label="GPU" value={`${deployment.specs.gpu.count}x ${deployment.specs.gpu.model || ''}`} />
          )}
          <StatItem label="RAM" value={formatSize(deployment.specs?.memory?.total, 'GB', 2) || '-'} />
          <StatItem label="Storage" value={formatSize(deployment.specs?.storage?.total, 'GB', 2) || '-'} />
        </div>

        <Separator className="bg-border-dim" />

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Connection Information</h3>
          <div className="space-y-2.5">
            {deployment.networking?.ipv4 && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground text-sm">IPv4</span>
                <ClickToCopyString value={deployment.networking.ipv4} />
              </div>
            )}
            {deployment.networking?.ipv6 && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground text-sm">IPv6</span>
                <ClickToCopyString value={deployment.networking.ipv6} truncate />
              </div>
            )}
            {sshCommand && (
              <div className="bg-muted rounded-lg p-3">
                <code className="font-mono text-sm">
                  <ClickToCopyString value={sshCommand} />
                </code>
              </div>
            )}
          </div>
        </div>

        {deployment.sshKeys && deployment.sshKeys.length > 0 && (
          <>
            <Separator className="bg-border-dim" />
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <h3 className="text-sm font-medium">SSH Keys</h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="text-muted-foreground h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      These are the SSH keys used during initial setup. Additional keys may have been added after
                      provisioning.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              {deployment.sshKeys.map((sshKey) => (
                <div key={sshKey.id} className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-5 w-5">
                      <AvatarFallback className="text-xs">{sshKey.user?.firstName?.[0] || '?'}</AvatarFallback>
                    </Avatar>
                    <span className="text-muted-foreground text-sm">
                      {sshKey.user?.firstName} {sshKey.user?.lastName}
                    </span>
                  </div>
                  <span className="truncate text-sm">{sshKey.name || 'SSH Key'}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {projectId && (
          <>
            <Separator className="bg-border-dim" />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link
                  to="/deployments/projects/$projectId/move-deployment/$deploymentId"
                  params={{ projectId, deploymentId }}
                >
                  <MoveUpRight className="mr-2 h-4 w-4" />
                  Move Deployment
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatItem({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className="bg-muted/50 rounded-lg px-3 py-2.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">{label}</p>
      <div className={cn('mt-1 text-sm leading-snug font-semibold', highlight && 'text-yellow-500')}>{value}</div>
    </div>
  );
}
