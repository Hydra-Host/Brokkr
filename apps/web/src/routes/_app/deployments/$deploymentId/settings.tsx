import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Loader2, Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Deployment } from '@repo/api-client';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';
import { isLocalSimulationEnabled } from '~/lib/env';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/settings')({
  staticData: { breadcrumb: 'Settings' },
  component: DeploymentSettings,
});

const renameSchema = z.object({
  name: z.string().min(1, 'Device name is required'),
});

type RenameFormData = z.infer<typeof renameSchema>;

function DeploymentSettings() {
  const deployment = parentRoute.useLoaderData() as Deployment;
  useDocumentTitle(`${deployment.customer?.deviceName ?? 'Deployment'} - Settings`);
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { mutateAsync: updateNickname, isPending: isRenaming } = tsr.updateDeploymentNickname.useMutation({
    meta: { successMessage: 'Device name updated' },
  });

  const renameForm = useForm<RenameFormData>({
    resolver: zodResolver(renameSchema),
    defaultValues: {
      name: deployment.customer?.deviceName || '',
    },
  });

  const handleRename = async (data: RenameFormData) => {
    await updateNickname({
      params: { id: String(deployment.id) },
      body: { name: data.name },
    });
    queryClient.removeQueries({ queryKey: ['deployment', String(deployment.id)] });
    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    await router.invalidate();
  };

  const { mutateAsync: toggleLock, isPending: isTogglingLock } = tsr.toggleDeploymentLock.useMutation({
    meta: {
      successMessage: deployment.isLocked ? 'Deployment unlocked' : 'Deployment locked',
    },
  });

  const handleToggleLock = async () => {
    await toggleLock({
      params: { id: String(deployment.id) },
      body: {},
    });
    queryClient.removeQueries({ queryKey: ['deployment', String(deployment.id)] });
    await router.invalidate();
  };

  const { mutateAsync: deprovision, isPending: isDeprovisioning } = tsr.deprovisionDeployment.useMutation({
    meta: { successMessage: 'Deployment deprovisioned' },
  });

  const [showEndRentalDialog, setShowEndRentalDialog] = useState(false);

  const isDisabled =
    (deployment.status?.value === 'failed' || deployment.status?.value === 'deprovisioning' || deployment.isLocked) &&
    !isLocalSimulationEnabled();

  const handleEndRental = async () => {
    await deprovision({
      params: { id: String(deployment.id) },
    });
    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    navigate({ to: '/deployments' });
  };

  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={renameForm.handleSubmit(handleRename)}>
          <CardHeader>
            <CardTitle>Deployment Information</CardTitle>
            <CardDescription>The basic controllable information about your device</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-w-md">
              <FormInput control={renameForm.control} name="name" label="Name" placeholder="My Server" />
            </div>
          </CardContent>
          <CardFooter className="px-4 py-4">
            <FormSubmitButton pending={isRenaming}>Save</FormSubmitButton>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{deployment.isLocked ? 'Unlock Deployment' : 'Lock Deployment'}</CardTitle>
          <CardDescription>
            {deployment.isLocked
              ? 'This will allow actions to be performed on the deployment'
              : 'This will prevent actions from being performed on the deployment'}
          </CardDescription>
        </CardHeader>
        <CardFooter className="px-4 py-4">
          <Button
            variant={deployment.isLocked ? 'default' : 'outline'}
            onClick={handleToggleLock}
            disabled={isTogglingLock}
          >
            {isTogglingLock && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {deployment.isLocked ? (
              <>
                <LockOpen className="mr-2 h-4 w-4" />
                Unlock Deployment
              </>
            ) : (
              <>
                <Lock className="mr-2 h-4 w-4" />
                Lock Deployment
              </>
            )}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>End Rental</CardTitle>
          <CardDescription>
            No longer want to use this device? You can end your rental here. This action is not reversible. All
            information related to this device will be deleted permanently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Button variant="destructive" onClick={() => setShowEndRentalDialog(true)} disabled={isDisabled}>
              End Rental
            </Button>
            {deployment.status?.value === 'failed' && (
              <div className="bg-muted rounded-lg p-4 font-semibold">
                <p className="text-destructive text-sm">
                  Support has been notified of the device failure, you should hear from us shortly.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showEndRentalDialog} onOpenChange={setShowEndRentalDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End Rental</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            <span className="text-destructive font-semibold">
              You are about to end your rental, this action is not reversible.
            </span>{' '}
            All information related to this device will be deleted permanently.
          </p>
          <p className="text-muted-foreground mt-2 text-sm leading-6">
            <span className="font-semibold">Looking to reprovision your device instead? </span>
            Head over to the{' '}
            <Link
              to="/deployments/$deploymentId/reprovision"
              params={{ deploymentId: String(deployment.id) }}
              className="text-primary hover:text-primary/80 underline"
              onClick={() => setShowEndRentalDialog(false)}
            >
              reprovision page
            </Link>{' '}
            to reprovision your device.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeprovisioning}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleEndRental} disabled={isDeprovisioning || isDisabled}>
              {isDeprovisioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              End Rental
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
