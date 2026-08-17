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

export const Route = createFileRoute('/_app/ipam/vlans/$vlanId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteVlanRoute,
});

function DeleteVlanRoute() {
  const { vlanId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVlan.useQuery({
    queryKey: ['vlan', vlanId],
    queryData: { params: { id: vlanId } },
  });

  const vlan = data?.status === 200 ? data.body : null;

  useDocumentTitle(vlan ? `Delete ${vlan.name}` : 'Delete VLAN');

  const { mutateAsync: archiveVlan, isPending } = tsr.archiveVlan.useMutation({
    meta: { successMessage: 'VLAN deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/vlans/$vlanId', params: { vlanId } });
  };

  const onDelete = async () => {
    await archiveVlan({
      params: { id: vlanId },
    });
    await queryClient.invalidateQueries({ queryKey: ['vlans'] });
    navigate({ to: '/ipam/vlans' });
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

  if (!vlan) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>VLAN not found</AlertDialogTitle>
            <AlertDialogDescription>The VLAN could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete VLAN: {vlan.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{vlan.name}</strong> (VID {vlan.vid})? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete VLAN'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
