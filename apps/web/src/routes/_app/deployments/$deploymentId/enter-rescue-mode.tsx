import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router';
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
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/enter-rescue-mode')({
  staticData: { breadcrumb: 'Enter Rescue Mode' },
  component: EnterRescueModeRoute,
});

function EnterRescueModeRoute() {
  const deployment = parentRoute.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const deploymentId = String(deployment.id);

  const { mutateAsync: activateRescueMode, isPending } = tsr.activateRescueMode.useMutation({
    meta: { successMessage: 'Rescue mode initiated successfully' },
  });

  const close = () => navigate({ to: '/deployments/$deploymentId', params: { deploymentId } });

  const handleActivate = async () => {
    await activateRescueMode({
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
          <AlertDialogTitle>Enter Rescue Mode</AlertDialogTitle>
          <AlertDialogDescription>
            Rescue Mode will reboot into a Live OS (in memory), where you can mount your drives, fix netplan,
            repartition drives, etc.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm">
            You can reboot afterwards to boot back to{' '}
            <strong>{deployment.specs?.operating_system || 'your operating system'}</strong>.
          </p>
          <p className="text-sm font-medium">Do you want to reboot into Rescue Mode?</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button onClick={handleActivate} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isPending ? 'Entering Rescue Mode...' : 'Enter Rescue Mode'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
