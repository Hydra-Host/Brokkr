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

export const Route = createFileRoute('/_app/device-models/$modelId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteDeviceModelRoute,
});

function DeleteDeviceModelRoute() {
  const { modelId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDeviceModel.useQuery({
    queryKey: ['device-model', modelId],
    queryData: { params: { id: modelId } },
  });

  const dm = data?.status === 200 ? data.body : null;
  useDocumentTitle(dm ? `Delete ${dm.manufacturer} ${dm.model}` : 'Delete Device Model');

  const { mutateAsync: deleteDm, isPending } = tsr.deleteDeviceModel.useMutation({
    meta: { successMessage: 'Device model deleted' },
  });

  const onClose = () => navigate({ to: '/device-models/$modelId', params: { modelId } });

  const onDelete = async () => {
    await deleteDm({ params: { id: modelId }, body: {} });
    await queryClient.invalidateQueries({ queryKey: ['device-models'] });
    navigate({ to: '/device-models' });
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

  if (!dm) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Device model not found</AlertDialogTitle>
            <AlertDialogDescription>The device model could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>
            Delete: {dm.manufacturer} {dm.model}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete{' '}
            <strong>
              {dm.manufacturer} {dm.model}
            </strong>
            ? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
