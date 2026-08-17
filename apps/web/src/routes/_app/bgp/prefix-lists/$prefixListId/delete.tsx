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

export const Route = createFileRoute('/_app/bgp/prefix-lists/$prefixListId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeletePrefixListRoute,
});

function DeletePrefixListRoute() {
  const { prefixListId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefixList.useQuery({
    queryKey: ['prefix-list', prefixListId],
    queryData: { params: { id: prefixListId } },
  });

  const prefixList = data?.status === 200 ? data.body : null;

  useDocumentTitle(prefixList ? `Delete ${prefixList.name}` : 'Delete Prefix List');

  const { mutateAsync: deletePrefixList, isPending } = tsr.deletePrefixList.useMutation({
    meta: { successMessage: 'Prefix list deleted' },
  });

  const onClose = () => {
    navigate({ to: '/bgp/prefix-lists/$prefixListId', params: { prefixListId } });
  };

  const onDelete = async () => {
    await deletePrefixList({
      params: { id: prefixListId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-lists'] });
    navigate({ to: '/bgp/prefix-lists' });
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

  if (!prefixList) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Prefix list not found</AlertDialogTitle>
            <AlertDialogDescription>The prefix list could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Prefix List: {prefixList.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{prefixList.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Prefix List'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
