import { createFileRoute, getRouteApi, Outlet } from '@tanstack/react-router';
import { Power, PowerOff, RefreshCcwDot } from 'lucide-react';

import type { Deployment } from '@repo/api-client';
import { ButtonLink } from '@repo/ui/components/button-link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@repo/ui/components/tooltip';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { isPowerActionDisabled } from '@repo/utils';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/power-control')({
  staticData: { breadcrumb: 'Power Control' },
  component: PowerControlLayout,
});

function PowerControlLayout() {
  const deployment = parentRoute.useLoaderData() as Deployment;
  useDocumentTitle(`${deployment.customer?.deviceName ?? 'Deployment'} - Power Control`);

  const isDisabledPowerCycle = isPowerActionDisabled(deployment, 'power-cycle');
  const isDisabledPowerOn = isPowerActionDisabled(deployment, 'on');
  const isDisabledPowerOff = isPowerActionDisabled(deployment, 'off');

  const deploymentId = String(deployment.id);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Power Control</CardTitle>
          <CardDescription>
            Manage the power state of your deployment. These actions affect the physical server your deployment runs on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 md:flex-row">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <ButtonLink
                      variant="default"
                      disabled={isDisabledPowerCycle}
                      to="/deployments/$deploymentId/power-control/power-cycle"
                      params={{ deploymentId }}
                    >
                      <RefreshCcwDot className="mr-2 h-4 w-4" />
                      Power Cycle
                    </ButtonLink>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {isDisabledPowerCycle
                    ? 'Device cannot be power cycled in this state'
                    : 'Hard power cycle (IPMI reset)'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <ButtonLink
                      variant="success"
                      disabled={isDisabledPowerOn}
                      to="/deployments/$deploymentId/power-control/on"
                      params={{ deploymentId }}
                    >
                      <Power className="mr-2 h-4 w-4" />
                      Power On
                    </ButtonLink>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{isDisabledPowerOn ? 'Device is already online' : 'Power On'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <ButtonLink
                      variant="destructive"
                      disabled={isDisabledPowerOff}
                      to="/deployments/$deploymentId/power-control/off"
                      params={{ deploymentId }}
                    >
                      <PowerOff className="mr-2 h-4 w-4" />
                      Power Off
                    </ButtonLink>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {isDisabledPowerOff ? 'Device cannot be powered off in this state' : 'Power Off'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </CardContent>
      </Card>

      <Outlet />
    </div>
  );
}
