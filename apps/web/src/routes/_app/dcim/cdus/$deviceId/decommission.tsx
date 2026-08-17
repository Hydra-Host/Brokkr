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

export const Route = createFileRoute('/_app/dcim/cdus/$deviceId/decommission')({
  staticData: { breadcrumb: 'Decommission' },
  component: DecommissionCduRoute,
});

function DecommissionCduRoute() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCduById.useQuery({
    queryKey: ['cdu', deviceId],
    queryData: { params: { deviceId } },
  });

  const cdu = data?.status === 200 ? data.body : null;

  useDocumentTitle(cdu ? `Decommission ${cdu.name}` : 'Decommission CDU');

  const { mutateAsync: decommissionCdu, isPending } = tsr.decommissionCdu.useMutation({
    meta: { successMessage: 'CDU decommissioned' },
  });

  const onClose = () => navigate({ to: '/dcim/cdus/$deviceId', params: { deviceId } });

  const onDecommission = async () => {
    await decommissionCdu({ params: { deviceId }, body: {} });
    await queryClient.invalidateQueries({ queryKey: ['cdu', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['cdus-active'] });
    await queryClient.invalidateQueries({ queryKey: ['cdus-decommissioned'] });
    navigate({ to: '/dcim/cdus' });
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

  if (!cdu) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>CDU not found</AlertDialogTitle>
            <AlertDialogDescription>The CDU could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (cdu.deletedAt) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>CDU already decommissioned</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{cdu.nickname || cdu.name}</strong> has already been decommissioned and cannot be decommissioned
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
          <AlertDialogTitle>Decommission CDU: {cdu.nickname || cdu.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to decommission <strong>{cdu.nickname || cdu.name}</strong>? It will be removed from
            the active list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDecommission} disabled={isPending}>
            {isPending ? 'Decommissioning...' : 'Decommission CDU'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
