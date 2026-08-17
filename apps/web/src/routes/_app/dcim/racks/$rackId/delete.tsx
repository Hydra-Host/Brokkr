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

export const Route = createFileRoute('/_app/dcim/racks/$rackId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteRackRoute,
});

function DeleteRackRoute() {
  const { rackId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimRack.useQuery({
    queryKey: ['dcim-rack', rackId],
    queryData: { params: { id: rackId } },
  });

  const rack = data?.status === 200 ? data.body : null;

  useDocumentTitle(rack ? `Delete ${rack.name}` : 'Delete Rack');

  const { mutateAsync: deleteRack, isPending } = tsr.deleteDcimRack.useMutation({
    meta: { successMessage: 'Rack deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/racks/$rackId', params: { rackId } });
  };

  const onDelete = async () => {
    await deleteRack({
      params: { id: rackId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-racks'] });
    navigate({ to: '/dcim/racks' });
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

  if (!rack) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Rack not found</AlertDialogTitle>
            <AlertDialogDescription>The rack could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Rack: {rack.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{rack.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Rack'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
