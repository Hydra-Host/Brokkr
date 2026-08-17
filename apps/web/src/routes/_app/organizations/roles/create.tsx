import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { FormInput } from '@repo/ui/form/form-input';
import { FormPermissionSelector } from '@repo/ui/form/form-permission-selector';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

const searchSchema = z.object({
  cloneFrom: z.string().optional(),
});

export const Route = createFileRoute('/_app/organizations/roles/create')({
  staticData: { breadcrumb: 'Create Role' },
  validateSearch: (search) => searchSchema.parse(search),
  component: CreateRoleDialog,
});

const createRoleFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(50),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(200).optional(),
  permissions: z.array(z.string()).min(1, 'Select at least one permission'),
});

type CreateRoleFormValues = z.infer<typeof createRoleFormSchema>;

function CreateRoleDialog() {
  useDocumentTitle('Create Custom Role');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { cloneFrom } = useSearch({ from: '/_app/organizations/roles/create' });
  const { can, permissions: actorPermissions } = usePermissions();
  const canManageRoles = can('member', 'change-role');

  const [error, setError] = useState<string | undefined>(undefined);

  const {
    data: permissionsResponse,
    isError: isPermissionsError,
    isFetching: isPermissionsFetching,
  } = tsr.listPermissions.useQuery({
    queryKey: ['permissions'],
  });

  const { data: rolesResponse } = tsr.listOrganizationRoles.useQuery({
    queryKey: ['organization-roles-for-clone'],
    enabled: !!cloneFrom,
  });

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
  const sourceRole =
    cloneFrom && rolesResponse?.status === 200 ? rolesResponse.body.find((r) => r.id === cloneFrom) : undefined;

  const form = useForm<CreateRoleFormValues>({
    resolver: zodResolver(createRoleFormSchema),
    defaultValues: {
      name: sourceRole ? `${sourceRole.name} (Custom)` : '',
      slug: sourceRole ? `${sourceRole.slug}-custom` : '',
      description: sourceRole?.description ?? '',
      permissions: [],
    },
  });

  useEffect(() => {
    if (sourceRole && isPermissionCatalogAuthoritative) {
      form.reset({
        name: `${sourceRole.name} (Custom)`,
        slug: `${sourceRole.slug}-custom`,
        description: sourceRole.description ?? '',
        permissions: sourceRole.rolePermissions
          .map((rp) => `${rp.permission.resource}:${rp.permission.action}`)
          .filter((permission) => canManageOwners || permission !== 'organization:manage-owners'),
      });
    }
  }, [canManageOwners, sourceRole, form, isPermissionCatalogAuthoritative]);

  const nameValue = form.watch('name');
  useEffect(() => {
    if (!cloneFrom) {
      const slug = nameValue
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
      form.setValue('slug', slug);
    }
  }, [nameValue, cloneFrom, form]);

  const { mutateAsync: createCustomRole, isPending } = tsr.createCustomRole.useMutation();

  function onClose() {
    navigate({ to: '/organizations/roles' });
  }

  const onSubmit = async (data: CreateRoleFormValues) => {
    setError(undefined);

    try {
      const res = await createCustomRole({
        body: {
          name: data.name,
          slug: data.slug,
          description: data.description || undefined,
          permissions: data.permissions,
          templateId: cloneFrom ?? undefined,
        },
      });

      if (res.status === 201) {
        toast.success(`Role "${data.name}" created successfully`);
        await queryClient.invalidateQueries({ queryKey: ['organization-roles'] });
        navigate({ to: '/organizations/roles' });
      } else {
        const body = res.body as { message?: string };
        setError(body?.message ?? 'Failed to create role');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create role. Please try again.';
      setError(message);
    }
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{cloneFrom ? 'Clone Role' : 'Create Custom Role'}</DialogTitle>
          <DialogDescription>
            {cloneFrom
              ? 'Create a custom role based on a system role. Adjust permissions as needed.'
              : 'Define a new custom role with specific permissions.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                control={form.control}
                name="name"
                label="Role Name"
                placeholder="e.g. Billing Manager"
                autoFocus
              />
              <FormInput
                control={form.control}
                name="slug"
                label="Slug"
                placeholder="e.g. billing-manager"
                description="Auto-generated from name"
              />
            </div>

            <FormTextarea
              control={form.control}
              name="description"
              label="Description"
              placeholder="Brief description of this role"
              rows={2}
            />

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
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {cloneFrom ? 'Clone Role' : 'Create Role'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
