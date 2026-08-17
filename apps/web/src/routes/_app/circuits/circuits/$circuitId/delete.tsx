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

export const Route = createFileRoute('/_app/circuits/circuits/$circuitId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteCircuitRoute,
});

function DeleteCircuitRoute() {
  const { circuitId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCircuit.useQuery({
    queryKey: ['circuit', circuitId],
    queryData: { params: { id: circuitId } },
  });

  const circuit = data?.status === 200 ? data.body : null;

  useDocumentTitle(circuit ? `Delete ${circuit.cid}` : 'Delete Circuit');

  const { mutateAsync: deleteCircuit, isPending } = tsr.deleteCircuit.useMutation({
    meta: { successMessage: 'Circuit deleted' },
  });

  const onClose = () => {
    navigate({ to: '/circuits/circuits/$circuitId', params: { circuitId } });
  };

  const onDelete = async () => {
    await deleteCircuit({
      params: { id: circuitId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['circuits'] });
    navigate({ to: '/circuits/circuits' });
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

  if (!circuit) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Circuit not found</AlertDialogTitle>
            <AlertDialogDescription>The circuit could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Circuit: {circuit.cid}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{circuit.cid}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Circuit'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
