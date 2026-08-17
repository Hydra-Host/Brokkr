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

export const Route = createFileRoute('/_app/dcim/cables/$cableId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteCableRoute,
});

function DeleteCableRoute() {
  const { cableId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimCable.useQuery({
    queryKey: ['dcim-cable', cableId],
    queryData: { params: { id: cableId } },
  });

  const cable = data?.status === 200 ? data.body : null;

  useDocumentTitle(cable ? `Delete ${cable.label || 'Cable'}` : 'Delete Cable');

  const { mutateAsync: deleteCable, isPending } = tsr.deleteDcimCable.useMutation({
    meta: { successMessage: 'Cable deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/cables/$cableId', params: { cableId } });
  };

  const onDelete = async () => {
    await deleteCable({
      params: { id: cableId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-cables'] });
    navigate({ to: '/dcim/cables' });
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

  if (!cable) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Cable not found</AlertDialogTitle>
            <AlertDialogDescription>The cable could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Cable: {cable.label || 'Unnamed Cable'}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this cable? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Cable'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
