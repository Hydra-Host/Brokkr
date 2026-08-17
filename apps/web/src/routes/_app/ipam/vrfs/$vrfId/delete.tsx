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

export const Route = createFileRoute('/_app/ipam/vrfs/$vrfId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteVrfRoute,
});

function DeleteVrfRoute() {
  const { vrfId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVrf.useQuery({
    queryKey: ['vrf', vrfId],
    queryData: { params: { id: vrfId } },
  });

  const vrf = data?.status === 200 ? data.body : null;

  useDocumentTitle(vrf ? `Delete ${vrf.name}` : 'Delete VRF');

  const { mutateAsync: archiveVrf, isPending } = tsr.archiveVrf.useMutation({
    meta: { successMessage: 'VRF deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/vrfs/$vrfId', params: { vrfId } });
  };

  const onDelete = async () => {
    await archiveVrf({
      params: { id: vrfId },
    });
    await queryClient.invalidateQueries({ queryKey: ['vrfs'] });
    navigate({ to: '/ipam/vrfs' });
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

  if (!vrf) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>VRF not found</AlertDialogTitle>
            <AlertDialogDescription>The VRF could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete VRF: {vrf.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{vrf.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete VRF'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
