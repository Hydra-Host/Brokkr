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

export const Route = createFileRoute('/_app/circuits/provider-networks/$networkId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteProviderNetworkRoute,
});

function DeleteProviderNetworkRoute() {
  const { networkId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getProviderNetwork.useQuery({
    queryKey: ['provider-network', networkId],
    queryData: { params: { id: networkId } },
  });

  const network = data?.status === 200 ? data.body : null;

  useDocumentTitle(network ? `Delete ${network.name}` : 'Delete Provider Network');

  const { mutateAsync: deleteProviderNetwork, isPending } = tsr.deleteProviderNetwork.useMutation({
    meta: { successMessage: 'Provider network deleted' },
  });

  const onClose = () => {
    navigate({ to: '/circuits/provider-networks/$networkId', params: { networkId } });
  };

  const onDelete = async () => {
    await deleteProviderNetwork({
      params: { id: networkId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['provider-networks'] });
    navigate({ to: '/circuits/provider-networks' });
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

  if (!network) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Provider network not found</AlertDialogTitle>
            <AlertDialogDescription>The provider network could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Provider Network: {network.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{network.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Provider Network'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
