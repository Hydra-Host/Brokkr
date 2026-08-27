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

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/exit-rescue-mode')({
  staticData: { breadcrumb: 'Exit Rescue Mode' },
  component: ExitRescueModeDialog,
});

function ExitRescueModeDialog() {
  const deployment = parentRoute.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { mutateAsync: deactivateRescueMode, isPending } = tsr.deactivateRescueMode.useMutation({
    meta: { successMessage: 'Exiting rescue mode successfully' },
  });

  const deploymentId = String(deployment.id);
  const operatingSystemName = deployment.specs?.operating_system;

  const onClose = () => {
    navigate({ to: '/deployments/$deploymentId', params: { deploymentId } });
  };

  const handleDeactivate = async () => {
    await deactivateRescueMode({
      params: { id: deploymentId },
      body: {},
    });
    queryClient.removeQueries({ queryKey: ['deployment', deploymentId] });
    await router.invalidate();
    onClose();
  };

  return (
    <AlertDialog open onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Exit Rescue Mode</AlertDialogTitle>
          <AlertDialogDescription>The system will be reverted to the previous operating system.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm">
            Your device will be rebooted and restored to{' '}
            <strong>{operatingSystemName || 'the previous operating system'}</strong>.
          </p>
          <p className="text-sm font-medium">Do you want to exit Rescue Mode?</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={handleDeactivate} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isPending ? 'Exiting Rescue Mode...' : 'Exit Rescue Mode'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
