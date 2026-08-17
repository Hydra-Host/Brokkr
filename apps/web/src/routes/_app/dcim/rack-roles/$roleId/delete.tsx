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
import { useEffect } from 'react';
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/rack-roles/$roleId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeleteRackRoleRoute,
});

function DeleteRackRoleRoute() {
  const { roleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isInstanceOperator, isPending: isCapabilityPending } = useIsInstanceOperator();

  const { data, isPending: isLoading } = tsr.getDcimRackRole.useQuery({
    queryKey: ['dcim-rack-role', roleId],
    queryData: { params: { id: roleId } },
  });

  const role = data?.status === 200 ? data.body : null;

  useDocumentTitle(role ? `Delete ${role.name}` : 'Delete Rack Role');

  const { mutateAsync: deleteRole, isPending } = tsr.deleteDcimRackRole.useMutation({
    meta: { successMessage: 'Rack role deleted' },
  });

  const onClose = () => {
    navigate({ to: '/dcim/rack-roles/$roleId', params: { roleId } });
  };

  const onDelete = async () => {
    await deleteRole({
      params: { id: roleId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['dcim-rack-roles'] });
    navigate({ to: '/dcim/rack-roles' });
  };

  useEffect(() => {
    if (!isCapabilityPending && !isInstanceOperator) {
      navigate({ to: '/dcim/rack-roles' });
    }
  }, [isCapabilityPending, isInstanceOperator, navigate]);

  if (isLoading || isCapabilityPending || !isInstanceOperator) {
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
            <AlertDialogTitle>Rack role not found</AlertDialogTitle>
            <AlertDialogDescription>The rack role could not be found.</AlertDialogDescription>
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
          <AlertDialogTitle>Delete Rack Role: {role.name}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete <strong>{role.name}</strong>? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Rack Role'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
