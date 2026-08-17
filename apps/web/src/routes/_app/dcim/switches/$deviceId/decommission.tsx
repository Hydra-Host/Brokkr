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

export const Route = createFileRoute('/_app/dcim/switches/$deviceId/decommission')({
  staticData: { breadcrumb: 'Decommission' },
  component: DecommissionSwitchRoute,
});

function DecommissionSwitchRoute() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getSwitchById.useQuery({
    queryKey: ['switch', deviceId],
    queryData: { params: { deviceId } },
  });

  const sw = data?.status === 200 ? data.body : null;

  useDocumentTitle(sw ? `Decommission ${sw.name}` : 'Decommission Switch');

  const { mutateAsync: decommissionSwitch, isPending } = tsr.decommissionSwitch.useMutation({
    meta: { successMessage: 'Switch decommissioned' },
  });

  const onClose = () => navigate({ to: '/dcim/switches/$deviceId', params: { deviceId } });

  const onDecommission = async () => {
    await decommissionSwitch({ params: { deviceId }, body: {} });
    await queryClient.invalidateQueries({ queryKey: ['switch', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['switches-active'] });
    await queryClient.invalidateQueries({ queryKey: ['switches-decommissioned'] });
    navigate({ to: '/dcim/switches' });
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

  if (!sw) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch not found</AlertDialogTitle>
            <AlertDialogDescription>The switch could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (sw.deletedAt) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch already decommissioned</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{sw.nickname || sw.name}</strong> has already been decommissioned and cannot be decommissioned
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
          <AlertDialogTitle>Decommission Switch: {sw.nickname || sw.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to decommission <strong>{sw.nickname || sw.name}</strong>? It will be removed from the
            active list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDecommission} disabled={isPending}>
            {isPending ? 'Decommissioning...' : 'Decommission Switch'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
