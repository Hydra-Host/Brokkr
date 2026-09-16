import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';

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
import { DEPLOYMENT_PROJECTS_KEY, LIFECYCLE_JOBS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/power-control/off')({
  staticData: { breadcrumb: 'Power Off' },
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

    if (isPowerActionDisabled(response.body, 'off')) {
      throw redirect({
        to: '/deployments/$deploymentId/power-control',
        params: { deploymentId: params.deploymentId },
      });
    }
  },
  component: PowerOffRoute,
});

function PowerOffRoute() {
  const deployment = parentRoute.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const deploymentId = String(deployment.id);

  const { mutateAsync: powerControl, isPending } = tsr.powerControlDeployment.useMutation({
    meta: { successMessage: 'Power Off successful' },
  });

  const close = () => navigate({ to: '/deployments/$deploymentId/power-control', params: { deploymentId } });

  const handlePowerOff = async () => {
    await powerControl({
      params: { id: deploymentId },
      body: { operation: 'off' },
    });
    queryClient.removeQueries({ queryKey: ['deployment', deploymentId] });
    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_JOBS_KEY });
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
          <AlertDialogTitle>Power Off Deployment</AlertDialogTitle>
          <AlertDialogDescription>
            Powering off the deployment will stop the deployment and all services running on it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={handlePowerOff} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Power Off
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
