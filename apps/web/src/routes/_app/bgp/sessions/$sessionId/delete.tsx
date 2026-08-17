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

export const Route = createFileRoute('/_app/bgp/sessions/$sessionId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteBgpSessionRoute,
});

function DeleteBgpSessionRoute() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getBgpSession.useQuery({
    queryKey: ['bgp-session', sessionId],
    queryData: { params: { id: sessionId } },
  });

  const session = data?.status === 200 ? data.body : null;

  useDocumentTitle(session ? `Delete ${session.name}` : 'Delete BGP Session');

  const { mutateAsync: deleteSession, isPending } = tsr.deleteBgpSession.useMutation({
    meta: { successMessage: 'BGP session deleted' },
  });

  const onClose = () => {
    navigate({ to: '/bgp/sessions/$sessionId', params: { sessionId } });
  };

  const onDelete = async () => {
    await deleteSession({
      params: { id: sessionId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['bgp-sessions'] });
    navigate({ to: '/bgp/sessions' });
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

  if (!session) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>BGP session not found</AlertDialogTitle>
            <AlertDialogDescription>The BGP session could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete BGP Session: {session.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{session.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete BGP Session'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
