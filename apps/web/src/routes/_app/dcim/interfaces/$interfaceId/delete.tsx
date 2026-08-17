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

export const Route = createFileRoute('/_app/dcim/interfaces/$interfaceId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteInterfaceRoute,
});

function DeleteInterfaceRoute() {
  const { interfaceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimInterface.useQuery({
    queryKey: ['dcim-interface', interfaceId],
    queryData: { params: { id: interfaceId } },
  });

  const iface = data?.status === 200 ? data.body : null;

  useDocumentTitle(iface ? `Delete ${iface.name}` : 'Delete Interface');

  const { mutateAsync: deleteInterface, isPending } = tsr.deleteDcimInterface.useMutation({
    meta: { successMessage: 'Interface deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/interfaces/$interfaceId', params: { interfaceId } });
  };

  const onDelete = async () => {
    await deleteInterface({
      params: { id: interfaceId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-interfaces'] });
    navigate({ to: '/dcim/interfaces' });
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

  if (!iface) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Interface not found</AlertDialogTitle>
            <AlertDialogDescription>The interface could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Interface: {iface.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{iface.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Interface'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
