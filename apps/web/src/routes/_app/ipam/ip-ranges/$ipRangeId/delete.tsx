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

export const Route = createFileRoute('/_app/ipam/ip-ranges/$ipRangeId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteIpRangeRoute,
});

function DeleteIpRangeRoute() {
  const { ipRangeId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpRange.useQuery({
    queryKey: ['ip-range', ipRangeId],
    queryData: { params: { id: ipRangeId } },
  });

  const ipRange = data?.status === 200 ? data.body : null;

  useDocumentTitle(ipRange ? `Delete ${ipRange.start} - ${ipRange.end}` : 'Delete IP Range');

  const { mutateAsync: archiveIpRange, isPending } = tsr.archiveIpRange.useMutation({
    meta: { successMessage: 'IP range deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/ip-ranges/$ipRangeId', params: { ipRangeId } });
  };

  const onDelete = async () => {
    await archiveIpRange({
      params: { id: ipRangeId },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-ranges'] });
    navigate({ to: '/ipam/ip-ranges' });
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

  if (!ipRange) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>IP range not found</AlertDialogTitle>
            <AlertDialogDescription>The IP range could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>
            Delete IP Range: {ipRange.start} - {ipRange.end}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the range{' '}
            <strong>
              {ipRange.start} - {ipRange.end}
            </strong>
            ? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete IP Range'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
