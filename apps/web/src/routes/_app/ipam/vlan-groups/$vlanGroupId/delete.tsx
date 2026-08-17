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

export const Route = createFileRoute('/_app/ipam/vlan-groups/$vlanGroupId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteVlanGroupRoute,
});

function DeleteVlanGroupRoute() {
  const { vlanGroupId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getVlanGroup.useQuery({
    queryKey: ['vlan-group', vlanGroupId],
    queryData: { params: { id: vlanGroupId } },
  });

  const vlanGroup = data?.status === 200 ? data.body : null;

  useDocumentTitle(vlanGroup ? `Delete ${vlanGroup.name}` : 'Delete VLAN Group');

  const { mutateAsync: deleteVlanGroup, isPending } = tsr.deleteVlanGroup.useMutation({
    meta: { successMessage: 'VLAN group deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/vlan-groups/$vlanGroupId', params: { vlanGroupId } });
  };

  const onDelete = async () => {
    await deleteVlanGroup({
      params: { id: vlanGroupId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['vlan-groups'] });
    navigate({ to: '/ipam/vlan-groups' });
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

  if (!vlanGroup) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>VLAN group not found</AlertDialogTitle>
            <AlertDialogDescription>The VLAN group could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete VLAN Group: {vlanGroup.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{vlanGroup.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete VLAN Group'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
