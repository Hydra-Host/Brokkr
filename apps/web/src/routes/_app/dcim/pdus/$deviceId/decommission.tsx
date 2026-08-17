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

export const Route = createFileRoute('/_app/dcim/pdus/$deviceId/decommission')({
  staticData: { breadcrumb: 'Decommission' },
  component: DecommissionPduRoute,
});

function DecommissionPduRoute() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPduById.useQuery({
    queryKey: ['pdu', deviceId],
    queryData: { params: { deviceId } },
  });

  const pdu = data?.status === 200 ? data.body : null;

  useDocumentTitle(pdu ? `Decommission ${pdu.name}` : 'Decommission PDU');

  const { mutateAsync: decommissionPdu, isPending } = tsr.decommissionPdu.useMutation({
    meta: { successMessage: 'PDU decommissioned' },
  });

  const onClose = () => navigate({ to: '/dcim/pdus/$deviceId', params: { deviceId } });

  const onDecommission = async () => {
    await decommissionPdu({ params: { deviceId }, body: {} });
    await queryClient.invalidateQueries({ queryKey: ['pdu', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['pdus-active'] });
    await queryClient.invalidateQueries({ queryKey: ['pdus-decommissioned'] });
    navigate({ to: '/dcim/pdus' });
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

  if (!pdu) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>PDU not found</AlertDialogTitle>
            <AlertDialogDescription>The PDU could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (pdu.deletedAt) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>PDU already decommissioned</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{pdu.nickname || pdu.name}</strong> has already been decommissioned and cannot be decommissioned
              again.
            </AlertDialogDescription>
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
          <AlertDialogTitle>Decommission PDU: {pdu.nickname || pdu.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to decommission <strong>{pdu.nickname || pdu.name}</strong>? It will be removed from
            the active list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDecommission} disabled={isPending}>
            {isPending ? 'Decommissioning...' : 'Decommission PDU'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
