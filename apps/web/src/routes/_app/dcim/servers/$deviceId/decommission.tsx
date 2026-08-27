import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router';
import { useState } from 'react';

import { Alert, AlertDescription } from '@repo/ui/components/alert';
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
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { DecommissionedServerOverlay } from '~/components/decommissioned-server-overlay';
import { tsr } from '~/lib/api';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/decommission')({
  staticData: { breadcrumb: 'Decommission' },
  component: DecommissionDevicePage,
});

function DecommissionDevicePage() {
  const device = parentRoute.useLoaderData();
  const params = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [openDialog, setOpenDialog] = useState(false);

  useDocumentTitle('Decommission Server');

  const { mutateAsync: decommissionDevice, isPending } = tsr.decommissionServer.useMutation({
    meta: { successMessage: 'Server has been decommissioned successfully' },
  });

  const hasActiveRental = !!device.deployment;
  const hasActiveInvite = !!device.reservationInvite;
  const isButtonDisabled = hasActiveRental || hasActiveInvite;

  const getDisabledReason = () => {
    if (hasActiveRental && hasActiveInvite) {
      return 'Cannot decommission server with active rental and reservation invite';
    }
    if (hasActiveRental) {
      return 'Cannot decommission server with active rental';
    }
    if (hasActiveInvite) {
      return 'Cannot decommission server with active reservation invite';
    }
    return '';
  };

  const onDecommission = async () => {
    await decommissionDevice({
      params: { deviceId: params.deviceId },
      body: {},
    });

    queryClient.removeQueries({ queryKey: ['server', params.deviceId] });
    await router.invalidate();
    navigate({
      to: '/dcim/servers/$deviceId',
      params: { deviceId: params.deviceId },
    });
  };

  return (
    <div className="relative max-w-3xl">
      <DecommissionedServerOverlay deletedAt={device.deletedAt} />
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3">
        <div>
          <h2 className="text-base leading-7 font-semibold">Decommission Server</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            This action is not reversible. All information related to this server will be deleted permanently.
          </p>
          {isButtonDisabled && (
            <Alert className="mt-4 border-orange-400/20 bg-orange-400/10">
              <AlertDescription className="text-orange-400">{getDisabledReason()}</AlertDescription>
            </Alert>
          )}
        </div>
        <div className="flex items-end">
          <Button
            variant="destructive"
            onClick={() => !isButtonDisabled && setOpenDialog(true)}
            disabled={isButtonDisabled}
          >
            Decommission Server
          </Button>
        </div>
      </div>

      <AlertDialog open={openDialog} onOpenChange={setOpenDialog}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Decommission Server</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="text-destructive font-semibold">
                You are about to decommission your server, this action is not reversible.
              </span>{' '}
              All information related to this server will be deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onDecommission} disabled={isPending}>
              {isPending ? 'Decommissioning...' : 'Decommission Server'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
