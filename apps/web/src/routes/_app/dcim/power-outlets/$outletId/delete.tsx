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

export const Route = createFileRoute('/_app/dcim/power-outlets/$outletId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeletePowerOutletRoute,
});

function DeletePowerOutletRoute() {
  const { outletId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getDcimPowerOutlet.useQuery({
    queryKey: ['dcim-power-outlet', outletId],
    queryData: { params: { id: outletId } },
  });

  const outlet = data?.status === 200 ? data.body : null;

  useDocumentTitle(outlet ? `Delete ${outlet.name}` : 'Delete Power Outlet');

  const { mutateAsync: deleteOutlet, isPending } = tsr.deleteDcimPowerOutlet.useMutation({
    meta: { successMessage: 'Power outlet deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/power-outlets/$outletId', params: { outletId } });
  };

  const onDelete = async () => {
    await deleteOutlet({
      params: { id: outletId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-power-outlets'] });
    navigate({ to: '/dcim/power-outlets' });
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

  if (!outlet) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Power outlet not found</AlertDialogTitle>
            <AlertDialogDescription>The power outlet could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Power Outlet: {outlet.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{outlet.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Power Outlet'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
