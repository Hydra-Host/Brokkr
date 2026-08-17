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

export const Route = createFileRoute('/_app/ipam/gateways/$gatewayId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteGatewayRoute,
});

function DeleteGatewayRoute() {
  const { gatewayId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getGateway.useQuery({
    queryKey: ['gateway', gatewayId],
    queryData: { params: { id: gatewayId } },
  });

  const gateway = data?.status === 200 ? data.body : null;

  useDocumentTitle(gateway ? `Delete Gateway` : 'Delete Gateway');

  const { mutateAsync: deleteGateway, isPending } = tsr.deleteGateway.useMutation({
    meta: { successMessage: 'Gateway deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/gateways/$gatewayId', params: { gatewayId } });
  };

  const onDelete = async () => {
    await deleteGateway({
      params: { id: gatewayId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['gateways'] });
    navigate({ to: '/ipam/gateways' });
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

  if (!gateway) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Gateway not found</AlertDialogTitle>
            <AlertDialogDescription>The gateway could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Gateway</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this gateway? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Gateway'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
