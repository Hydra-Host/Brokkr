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

export const Route = createFileRoute('/_app/circuits/providers/$providerId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteProviderRoute,
});

function DeleteProviderRoute() {
  const { providerId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getProvider.useQuery({
    queryKey: ['provider', providerId],
    queryData: { params: { id: providerId } },
  });

  const provider = data?.status === 200 ? data.body : null;

  useDocumentTitle(provider ? `Delete ${provider.name}` : 'Delete Provider');

  const { mutateAsync: deleteProvider, isPending } = tsr.deleteProvider.useMutation({
    meta: { successMessage: 'Provider deleted' },
  });

  const onClose = () => {
    navigate({ to: '/circuits/providers/$providerId', params: { providerId } });
  };

  const onDelete = async () => {
    await deleteProvider({
      params: { id: providerId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['providers'] });
    navigate({ to: '/circuits/providers' });
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

  if (!provider) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Provider not found</AlertDialogTitle>
            <AlertDialogDescription>The provider could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Provider: {provider.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{provider.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Provider'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
