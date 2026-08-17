import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
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
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { AlertCircle } from 'lucide-react';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuit-types/$typeId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteCircuitTypeRoute,
});

function DeleteCircuitTypeRoute() {
  const { typeId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isTypeLoading } = tsr.getCircuitType.useQuery({
    queryKey: ['circuit-type', typeId],
    queryData: { params: { id: typeId } },
  });

  const { data: circuitsData, isPending: isCircuitsLoading } = tsr.listCircuits.useQuery({
    queryKey: ['circuits', { circuitTypeId: typeId }],
    queryData: { query: { circuitTypeId: typeId } },
  });

  const circuitType = data?.status === 200 ? data.body : null;
  const circuitsUsingType = circuitsData?.status === 200 ? circuitsData.body : [];
  const usageCount = circuitsUsingType.length;
  const isBlocked = usageCount > 0;

  useDocumentTitle(circuitType ? `Delete ${circuitType.name}` : 'Delete Circuit Type');

  const { mutateAsync: deleteCircuitType, isPending } = tsr.deleteCircuitType.useMutation({
    meta: { successMessage: 'Circuit type deleted' },
  });

  const onClose = () => {
    navigate({ to: '/circuits/circuit-types/$typeId', params: { typeId } });
  };

  const onDelete = async () => {
    await deleteCircuitType({
      params: { id: typeId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['circuit-types'] });
    navigate({ to: '/circuits/circuit-types' });
  };

  if (isTypeLoading || isCircuitsLoading) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <Skeleton className="h-24" />
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (!circuitType) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Circuit type not found</AlertDialogTitle>
            <AlertDialogDescription>The circuit type could not be found.</AlertDialogDescription>
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
      <AlertDialogContent className="sm:max-w-[480px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Circuit Type: {circuitType.name}</AlertDialogTitle>
          <AlertDialogDescription>
            {isBlocked
              ? 'This circuit type is still in use and cannot be deleted.'
              : `Are you sure you want to delete ${circuitType.name}? This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isBlocked && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>
              In use by {usageCount} circuit{usageCount === 1 ? '' : 's'}
            </AlertTitle>
            <AlertDescription>
              <p className="mb-2">Reassign or delete the following before removing this type:</p>
              <ul className="list-disc space-y-1 pl-5">
                {circuitsUsingType.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <Link
                      to="/circuits/circuits/$circuitId"
                      params={{ circuitId: c.id }}
                      className="underline hover:no-underline"
                    >
                      {c.cid}
                    </Link>
                  </li>
                ))}
                {usageCount > 5 && <li className="list-none italic">…and {usageCount - 5} more</li>}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending || isBlocked}>
            {isPending ? 'Deleting...' : 'Delete Circuit Type'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
