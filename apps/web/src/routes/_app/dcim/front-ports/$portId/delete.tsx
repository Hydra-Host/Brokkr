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

export const Route = createFileRoute('/_app/dcim/front-ports/$portId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteFrontPortRoute,
});

function DeleteFrontPortRoute() {
  const { portId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimFrontPort.useQuery({
    queryKey: ['dcim-front-port', portId],
    queryData: { params: { id: portId } },
  });

  const port = data?.status === 200 ? data.body : null;

  useDocumentTitle(port ? `Delete ${port.name}` : 'Delete Front Port');

  const { mutateAsync: deletePort, isPending } = tsr.deleteDcimFrontPort.useMutation({
    meta: { successMessage: 'Front port deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/front-ports/$portId', params: { portId } });
  };

  const onDelete = async () => {
    await deletePort({
      params: { id: portId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-front-ports'] });
    navigate({ to: '/dcim/front-ports' });
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
            <AlertDialogTitle>Front port not found</AlertDialogTitle>
            <AlertDialogDescription>The front port could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Front Port: {port.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{port.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Front Port'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
