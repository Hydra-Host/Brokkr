import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';

import type { Deployment } from '@repo/api-client';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { isPowerActionDisabled } from '@repo/utils';
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/power-control/power-cycle')({
  staticData: { breadcrumb: 'Power Cycle' },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['deployment', params.deploymentId],
      queryFn: () =>
        tsr.getDeploymentById.query({
          params: { id: params.deploymentId },
        }),
    });

    if (response.status !== 200) {
      throw redirect({
        to: '/deployments/$deploymentId/power-control',
        params: { deploymentId: params.deploymentId },
      });
    }

    if (isPowerActionDisabled(response.body, 'power-cycle')) {
      throw redirect({
        to: '/deployments/$deploymentId/power-control',
        params: { deploymentId: params.deploymentId },
      });
    }
  },
  component: PowerCycleRoute,
});

function PowerCycleRoute() {
  const deployment = parentRoute.useLoaderData() as Deployment;
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const deploymentId = String(deployment.id);

  const { mutateAsync: powerCycle, isPending } = tsr.powerCycleDeployment.useMutation({
    meta: { successMessage: 'Power cycle initiated' },
  });

  const close = () => navigate({ to: '/deployments/$deploymentId/power-control', params: { deploymentId } });

  const handlePowerCycle = async () => {
    await powerCycle({
      params: { id: deploymentId },
      body: {},
    });
    queryClient.removeQueries({ queryKey: ['deployment', deploymentId] });
    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    await router.invalidate();
    close();
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Power Cycle Deployment</AlertDialogTitle>
          <AlertDialogDescription>
            Power cycling the deployment will perform a hard reset, equivalent to physically unplugging and re-plugging
            the machine. All running processes will be terminated immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button onClick={handlePowerCycle} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Power Cycle
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
