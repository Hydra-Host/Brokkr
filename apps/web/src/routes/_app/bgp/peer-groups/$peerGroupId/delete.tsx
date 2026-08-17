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

export const Route = createFileRoute('/_app/bgp/peer-groups/$peerGroupId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteBgpPeerGroupRoute,
});

function DeleteBgpPeerGroupRoute() {
  const { peerGroupId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getBgpPeerGroup.useQuery({
    queryKey: ['bgp-peer-group', peerGroupId],
    queryData: { params: { id: peerGroupId } },
  });

  const peerGroup = data?.status === 200 ? data.body : null;

  useDocumentTitle(peerGroup ? `Delete ${peerGroup.name}` : 'Delete Peer Group');

  const { mutateAsync: deletePeerGroup, isPending } = tsr.deleteBgpPeerGroup.useMutation({
    meta: { successMessage: 'BGP peer group deleted' },
  });

  const onClose = () => {
    navigate({ to: '/bgp/peer-groups/$peerGroupId', params: { peerGroupId } });
  };

  const onDelete = async () => {
    await deletePeerGroup({
      params: { id: peerGroupId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-peer-groups'] });
    navigate({ to: '/bgp/peer-groups' });
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

  if (!peerGroup) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Peer group not found</AlertDialogTitle>
            <AlertDialogDescription>The BGP peer group could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Peer Group: {peerGroup.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{peerGroup.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Peer Group'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
