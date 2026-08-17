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
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/power-ports/$portId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeletePowerPortRoute,
});

function DeletePowerPortRoute() {
  const { portId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimPowerPort.useQuery({
    queryKey: ['dcim-power-port', portId],
    queryData: { params: { id: portId } },
  });

  const port = data?.status === 200 ? data.body : null;

  useDocumentTitle(port ? `Delete ${port.name}` : 'Delete Power Port');

  const { mutateAsync: deletePort, isPending } = tsr.deleteDcimPowerPort.useMutation({
    meta: { successMessage: 'Power port deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/power-ports/$portId', params: { portId } });
  };

  const onDelete = async () => {
    await deletePort({
      params: { id: portId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-power-ports'] });
    navigate({ to: '/dcim/power-ports' });
  };

  if (isLoading) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <Skeleton className="h-24" />
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (!port) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Power port not found</AlertDialogTitle>
            <AlertDialogDescription>The power port could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Power Port: {port.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{port.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Power Port'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
