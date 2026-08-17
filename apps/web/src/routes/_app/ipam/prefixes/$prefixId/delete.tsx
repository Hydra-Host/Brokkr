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

export const Route = createFileRoute('/_app/ipam/prefixes/$prefixId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeletePrefixRoute,
});

function DeletePrefixRoute() {
  const { prefixId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefix.useQuery({
    queryKey: ['prefix', prefixId],
    queryData: { params: { id: prefixId } },
  });

  const prefix = data?.status === 200 ? data.body : null;

  useDocumentTitle(prefix ? `Delete ${prefix.prefix}` : 'Delete Prefix');

  const { mutateAsync: archivePrefix, isPending } = tsr.archivePrefix.useMutation({
    meta: { successMessage: 'Prefix deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/prefixes/$prefixId', params: { prefixId } });
  };

  const onDelete = async () => {
    await archivePrefix({
      params: { id: prefixId },
    });
    await queryClient.invalidateQueries({ queryKey: ['prefixes'] });
    navigate({ to: '/ipam/prefixes' });
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

  if (!prefix) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Prefix not found</AlertDialogTitle>
            <AlertDialogDescription>The prefix could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Prefix: {prefix.prefix}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{prefix.prefix}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Prefix'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
