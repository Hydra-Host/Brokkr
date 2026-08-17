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

export const Route = createFileRoute('/_app/dcim/routers/$deviceId/decommission')({
  staticData: { breadcrumb: 'Decommission' },
  component: DecommissionRouterRoute,
});

function DecommissionRouterRoute() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getRouterById.useQuery({
    queryKey: ['router', deviceId],
    queryData: { params: { deviceId } },
  });

  const rtr = data?.status === 200 ? data.body : null;

  useDocumentTitle(rtr ? `Decommission ${rtr.name}` : 'Decommission Router');

  const { mutateAsync: decommissionRouter, isPending } = tsr.decommissionRouter.useMutation({
    meta: { successMessage: 'Router decommissioned' },
  });

  const onClose = () => navigate({ to: '/dcim/routers/$deviceId', params: { deviceId } });

  const onDecommission = async () => {
    await decommissionRouter({ params: { deviceId }, body: {} });
    await queryClient.invalidateQueries({ queryKey: ['router', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['routers-active'] });
    await queryClient.invalidateQueries({ queryKey: ['routers-decommissioned'] });
    navigate({ to: '/dcim/routers' });
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

  if (!rtr) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Router not found</AlertDialogTitle>
            <AlertDialogDescription>The router could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (rtr.deletedAt) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Router already decommissioned</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{rtr.nickname || rtr.name}</strong> has already been decommissioned and cannot be decommissioned
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
          <AlertDialogTitle>Decommission Router: {rtr.nickname || rtr.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to decommission <strong>{rtr.nickname || rtr.name}</strong>? It will be removed from
            the active list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDecommission} disabled={isPending}>
            {isPending ? 'Decommissioning...' : 'Decommission Router'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
