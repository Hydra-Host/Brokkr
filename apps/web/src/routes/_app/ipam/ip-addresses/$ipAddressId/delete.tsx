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

export const Route = createFileRoute('/_app/ipam/ip-addresses/$ipAddressId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteIpAddressRoute,
});

function DeleteIpAddressRoute() {
  const { ipAddressId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', ipAddressId],
    queryData: { params: { id: ipAddressId } },
  });

  const ipAddress = data?.status === 200 ? data.body : null;

  useDocumentTitle(ipAddress ? `Delete ${ipAddress.address}` : 'Delete IP Address');

  const { mutateAsync: archiveIpAddress, isPending } = tsr.archiveIpAddress.useMutation({
    meta: { successMessage: 'IP address deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/ip-addresses/$ipAddressId', params: { ipAddressId } });
  };

  const onDelete = async () => {
    await archiveIpAddress({
      params: { id: ipAddressId },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-addresses'] });
    navigate({ to: '/ipam/ip-addresses' });
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

  if (!ipAddress) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>IP address not found</AlertDialogTitle>
            <AlertDialogDescription>The IP address could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete IP Address: {ipAddress.address}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{ipAddress.address}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete IP Address'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
