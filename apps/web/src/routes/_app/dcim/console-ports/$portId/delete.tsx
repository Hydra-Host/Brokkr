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

export const Route = createFileRoute('/_app/dcim/console-ports/$portId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteConsolePortRoute,
});

function DeleteConsolePortRoute() {
  const { portId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimConsolePort.useQuery({
    queryKey: ['dcim-console-port', portId],
    queryData: { params: { id: portId } },
  });

  const port = data?.status === 200 ? data.body : null;

  useDocumentTitle(port ? `Delete ${port.name}` : 'Delete Console Port');

  const { mutateAsync: deletePort, isPending } = tsr.deleteDcimConsolePort.useMutation({
    meta: { successMessage: 'Console port deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/console-ports/$portId', params: { portId } });
  };

  const onDelete = async () => {
    await deletePort({
      params: { id: portId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-console-ports'] });
    navigate({ to: '/dcim/console-ports' });
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
            <AlertDialogTitle>Console port not found</AlertDialogTitle>
            <AlertDialogDescription>The console port could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Console Port: {port.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{port.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Console Port'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
