import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { FormPermissionSelector } from '@repo/domain-ui/form/form-permission-selector';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { unwrapErrorMessage } from '@repo/utils';
import { BootScreen } from '~/components/boot-screen';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

const searchSchema = z.object({
  action: z.enum(['archive']).optional(),
});
const editRoleFormSchema = z.object({
  permissions: z.array(z.string()).min(1, 'Select at least one permission'),
});
type EditRoleFormValues = z.infer<typeof editRoleFormSchema>;

export const Route = createFileRoute('/_app/organizations/roles/edit/$roleId')({
  staticData: { breadcrumb: 'Edit Role' },
  validateSearch: (search) => searchSchema.parse(search),
  component: EditRoleDialog,
});

function EditRoleDialog() {
  useDocumentTitle('Edit Role');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { roleId } = useParams({ from: '/_app/organizations/roles/edit/$roleId' });
  const { action } = useSearch({ from: '/_app/organizations/roles/edit/$roleId' });
  const { can, permissions: actorPermissions } = usePermissions();
  const canManageRoles = can('member', 'change-role');

  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const form = useForm<EditRoleFormValues>({
    resolver: zodResolver(editRoleFormSchema),
    defaultValues: { permissions: [] },
  });

  const { data: roleResponse, isLoading: isRoleLoading } = tsr.getOrganizationRole.useQuery({
    queryKey: ['organization-role', roleId],
    queryData: { params: { roleId } },
  });

  const {
    data: permissionsResponse,
    isError: isPermissionsError,
    isFetching: isPermissionsFetching,
  } = tsr.listPermissions.useQuery({
    queryKey: ['permissions'],
  });

  const role = roleResponse?.status === 200 ? roleResponse.body : undefined;
  const permissions = useMemo(
    () => (permissionsResponse?.status === 200 ? permissionsResponse.body : []),
    [permissionsResponse],
  );
  const isPermissionCatalogAuthoritative =
    permissionsResponse?.status === 200 && !isPermissionsError && !isPermissionsFetching;
  const canManageOwners =
    isPermissionCatalogAuthoritative &&
    permissions.length > 0 &&
    permissions.every(({ resource, action }) => actorPermissions.has(`${resource}:${action}`));

  useEffect(() => {
    if (role && isPermissionCatalogAuthoritative && !initialized) {
      form.reset({
        permissions: role.rolePermissions
          .map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
          .filter((permission) => canManageOwners || permission !== 'organization:manage-owners'),
      });
      setInitialized(true);
    }
  }, [canManageOwners, form, initialized, isPermissionCatalogAuthoritative, role]);

  const { mutateAsync: updatePermissions, isPending: isUpdating } = tsr.updateRolePermissions.useMutation();
  const { mutateAsync: archiveRole, isPending: isArchiving } = tsr.archiveCustomRole.useMutation();

  function onClose() {
    navigate({ to: '/organizations/roles' });
  }

  if (isRoleLoading) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-2xl">
          <BootScreen />
        </DialogContent>
      </Dialog>
    );
  }

  if (role?.isSystem) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cannot Edit System Role</DialogTitle>
            <DialogDescription>
              System roles cannot be modified. Clone this role to create a customizable version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!role) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Role Not Found</DialogTitle>
            <DialogDescription>The requested role could not be found.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (action === 'archive') {
    return (
      <ArchiveRoleDialog
        roleName={role.name}
        memberCount={role._count.members}
        pendingInvitationCount={role._count.invitations}
        canManage={canManageRoles}
        isArchiving={isArchiving}
        onArchive={async () => {
          setError(undefined);
          try {
            const res = await archiveRole({ params: { roleId } });
            if (res.status === 200) {
              toast.success(`Role "${role.name}" archived`);
              await queryClient.invalidateQueries({ queryKey: ['organization-roles'] });
              navigate({ to: '/organizations/roles' });
            } else {
              setError('Failed to archive role');
            }
          } catch (err) {
            const message = unwrapErrorMessage(err, 'Failed to archive role');
            setError(message);
          }
        }}
        onClose={onClose}
        error={error}
      />
    );
  }

  const handleSave = async (values: EditRoleFormValues) => {
    setError(undefined);

    try {
      const res = await updatePermissions({
        params: { roleId },
        body: { permissions: values.permissions },
      });

      if (res.status === 200) {
        toast.success(`Role "${role.name}" updated`);
        await queryClient.invalidateQueries({ queryKey: ['organization-roles'] });
        await queryClient.invalidateQueries({ queryKey: ['organization-role', roleId] });
        navigate({ to: '/organizations/roles' });
      } else {
        setError(unwrapErrorMessage(res, 'Failed to update role'));
      }
    } catch (err) {
      const message = unwrapErrorMessage(err, 'Failed to update role');
      setError(message);
    }
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Edit Role: {role.name}</DialogTitle>
          <DialogDescription>Update the permissions for this custom role.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium">Name</p>
              <p className="text-muted-foreground text-sm">{role.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium">Slug</p>
              <Badge variant="outline" className="font-mono text-xs">
                {role.slug}
              </Badge>
            </div>
          </div>

          {role.description && (
            <div>
              <p className="text-sm font-medium">Description</p>
              <p className="text-muted-foreground text-sm">{role.description}</p>
            </div>
          )}

          <FormPermissionSelector
            control={form.control}
            name="permissions"
            label="Permissions"
            permissions={permissions}
            isPermissionCatalogAuthoritative={isPermissionCatalogAuthoritative}
            isPermissionDisabled={({ resource, action }) =>
              !canManageOwners && `${resource}:${action}` === 'organization:manage-owners'
            }
            emptyMessage="You have no permissions available to grant."
          />

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="border-t pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {canManageRoles && (
            <Button onClick={form.handleSubmit(handleSave)} disabled={isUpdating}>
              {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveRoleDialog({
  roleName,
  memberCount,
  pendingInvitationCount,
  canManage,
  isArchiving,
  onArchive,
  onClose,
  error,
}: {
  roleName: string;
  memberCount: number;
  pendingInvitationCount: number;
  canManage: boolean;
  isArchiving: boolean;
  onArchive: () => void;
  onClose: () => void;
  error?: string;
}) {
  const canArchive = memberCount === 0 && pendingInvitationCount === 0;
  const blockers = [
    memberCount > 0 ? `${memberCount} active member${memberCount === 1 ? '' : 's'}` : undefined,
    pendingInvitationCount > 0
      ? `${pendingInvitationCount} pending invitation${pendingInvitationCount === 1 ? '' : 's'}`
      : undefined,
  ].filter((blocker) => blocker !== undefined);

  return (
    <AlertDialog open={true} onOpenChange={onClose}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive h-5 w-5" />
            Archive Role
          </AlertDialogTitle>
          <AlertDialogDescription>
            {canArchive
              ? `Archive "${roleName}"? It will no longer be available for assignment, while historical records will retain its name.`
              : `Cannot archive "${roleName}" because it has ${blockers.join(' and ')}. Reassign members and resolve pending invitations first.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {canManage && (
            <Button variant="destructive" onClick={onArchive} disabled={!canArchive || isArchiving}>
              {isArchiving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Archive Role
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
