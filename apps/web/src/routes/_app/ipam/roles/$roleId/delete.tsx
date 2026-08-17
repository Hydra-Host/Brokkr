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

export const Route = createFileRoute('/_app/ipam/roles/$roleId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteIpamRoleRoute,
});

function DeleteIpamRoleRoute() {
  const { roleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getIpamRole.useQuery({
    queryKey: ['ipam-role', roleId],
    queryData: { params: { id: roleId } },
  });

  const role = data?.status === 200 ? data.body : null;

  useDocumentTitle(role ? `Delete ${role.name}` : 'Delete IPAM Role');

  const { mutateAsync: deleteIpamRole, isPending } = tsr.deleteIpamRole.useMutation({
    meta: { successMessage: 'IPAM role deleted' },
  });

  const onClose = () => {
    navigate({ to: '/ipam/roles/$roleId', params: { roleId } });
  };

  const onDelete = async () => {
    await deleteIpamRole({
      params: { id: roleId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['ipam-roles'] });
    navigate({ to: '/ipam/roles' });
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

  if (!role) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>IPAM role not found</AlertDialogTitle>
            <AlertDialogDescription>The IPAM role could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete IPAM Role: {role.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{role.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Role'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
