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

export const Route = createFileRoute('/_app/circuits/circuit-terminations/$terminationId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteCircuitTerminationRoute,
});

function DeleteCircuitTerminationRoute() {
  const { terminationId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCircuitTermination.useQuery({
    queryKey: ['circuit-termination', terminationId],
    queryData: { params: { id: terminationId } },
  });

  const termination = data?.status === 200 ? data.body : null;

  useDocumentTitle(termination ? `Delete Termination ${termination.termSide}` : 'Delete Termination');

  const { mutateAsync: deleteTermination, isPending } = tsr.deleteCircuitTermination.useMutation({
    meta: { successMessage: 'Circuit termination deleted' },
  });

  const onClose = () => {
    navigate({ to: '/circuits/circuit-terminations/$terminationId', params: { terminationId } });
  };

  const onDelete = async () => {
    await deleteTermination({
      params: { id: terminationId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-terminations'] });
    navigate({ to: '/circuits/circuit-terminations' });
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

  if (!termination) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Termination not found</AlertDialogTitle>
            <AlertDialogDescription>The circuit termination could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Termination: {termination.termSide}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete termination <strong>{termination.termSide}</strong>? This action cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Termination'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
