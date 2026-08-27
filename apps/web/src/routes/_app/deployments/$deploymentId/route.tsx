import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Ambulance, MapPin, Power, RefreshCw, Settings } from 'lucide-react';

import type { Deployment } from '@repo/api-client';
import { DeviceStatusBadge } from '@repo/domain-ui/components/device-status-badge';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { ButtonLink } from '@repo/ui/components/button-link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { CountdownTimer } from '@repo/ui/components/countdown-timer';
import { TypewriterText } from '@repo/ui/components/typewriter-text';

import { useDeploymentEvents } from '~/hooks/use-device-events';
import { tsr } from '~/lib/api';
import { isLocalSimulationEnabled } from '~/lib/env';

const deploymentQueryKey = (deploymentId: string) => ['deployment', deploymentId] as const;

export const Route = createFileRoute('/_app/deployments/$deploymentId')({
  staticData: {
    breadcrumb: (data) => (data as Deployment)?.customer?.deviceName ?? 'Deployment',
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: deploymentQueryKey(params.deploymentId),
      queryFn: () =>
        tsr.getDeploymentById.query({
          params: { id: params.deploymentId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load deployment');
    }

    return response.body;
  },
  component: DeploymentLayout,
});

function DeploymentLayout() {
  const deployment = Route.useLoaderData();
  useDeploymentEvents(String(deployment.id));

  return (
    <div className="space-y-4">
      <DeploymentHeader deployment={deployment} />
      <Outlet />
    </div>
  );
}

function DeploymentHeader({ deployment }: { deployment: Deployment }) {
  const isQueued = deployment.status?.label?.toLowerCase() === 'queued';
  const inRescueMode = !!deployment.specs?.current_rescue_operating_system_name;
  // Entering rescue is gated on a settled status (backend enforces the same); Exit must NOT be gated — a device in rescue is no longer `provisioned`/`failed`, so gating Exit would strand it.
  const canEnterRescueMode = ['provisioned', 'failed'].includes(deployment.status?.value ?? '');

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 space-x-8">
          <div className="space-y-2">
            <CardTitle className="text-2xl">
              <TypewriterText text={deployment.customer?.deviceName || 'Deployment'} />
            </CardTitle>
            <div className="flex items-center gap-2">
              <DeviceStatusBadge status={deployment.status?.label ?? ''} />
              <DeviceStatusBadge status={deployment.powerStatus?.label || ''} icon={Power} />
              <Badge variant="secondary">
                <MapPin className="mr-1.5 h-3 w-3" />
                {deployment.location}
              </Badge>
            </div>
            {deployment.customer?.provisionedDate && (
              <CardDescription>
                Provisioned on{' '}
                {new Date(deployment.customer.provisionedDate).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </CardDescription>
            )}
            <p className="text-muted-foreground text-sm">ID: {deployment.id}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <ButtonLink
              variant="outline"
              size="sm"
              to="/deployments/$deploymentId/reprovision"
              params={{ deploymentId: String(deployment.id) }}
              disabled={(isQueued || deployment.isLocked) && !isLocalSimulationEnabled()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reprovision
            </ButtonLink>
            <ButtonLink
              variant="outline"
              size="sm"
              to="/deployments/$deploymentId/power-control"
              params={{ deploymentId: String(deployment.id) }}
            >
              <Power className="mr-2 h-4 w-4" />
              Power Control
            </ButtonLink>
            <ButtonLink
              variant="outline"
              size="sm"
              to="/deployments/$deploymentId/settings"
              params={{ deploymentId: String(deployment.id) }}
            >
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </ButtonLink>
            {inRescueMode ? (
              <ButtonLink
                variant="destructive"
                size="sm"
                to="/deployments/$deploymentId/exit-rescue-mode"
                params={{ deploymentId: String(deployment.id) }}
              >
                <Ambulance className="mr-2 h-4 w-4" />
                Exit Rescue Mode
              </ButtonLink>
            ) : (
              canEnterRescueMode && (
                <ButtonLink
                  variant="outline"
                  size="sm"
                  to="/deployments/$deploymentId/enter-rescue-mode"
                  params={{ deploymentId: String(deployment.id) }}
                >
                  <Ambulance className="mr-2 h-4 w-4" />
                  Rescue Mode
                </ButtonLink>
              )
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {deployment.scheduledInterruptionTime && (
              <CountdownTimer
                endTime={new Date(deployment.scheduledInterruptionTime)}
                title="This deployment is being interrupted"
                subtext="This deployment will be deprovisioned and reassigned. Please back up any data before the deadline."
              />
            )}
          </div>
          {deployment.isLocked && (
            <Alert variant="destructive">
              <AlertTitle>Deployment Locked</AlertTitle>
              <AlertDescription>
                This deployment is locked. To perform actions on the deployment, unlock it in the settings page.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </>
  );
}
