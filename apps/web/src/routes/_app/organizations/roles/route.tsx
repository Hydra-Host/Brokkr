import { useSession } from '@repo/auth/client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { isRecord } from '@repo/utils';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Archive, Copy, Lock, Pencil, Plus, Shield } from 'lucide-react';
import { useMemo } from 'react';
import { BootScreen } from '~/components/boot-screen';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

import type { OrganizationMemberRole } from '@repo/api-client';

export const Route = createFileRoute('/_app/organizations/roles')({
  staticData: { breadcrumb: 'Roles' },
  component: RolesPage,
});

function RolesPage() {
  useDocumentTitle('Organization Roles');
  const { data: session } = useSession();
  const activeOrgId =
    isRecord(session?.session) && typeof session.session.activeOrganizationId === 'string'
      ? session.session.activeOrganizationId
      : undefined;

  const { data: rolesResponse, isLoading: isRolesLoading } = tsr.listOrganizationRoles.useQuery({
    queryKey: ['organization-roles', activeOrgId],
    enabled: !!activeOrgId,
  });

  const { can, permissions } = usePermissions();
  const canManageRoles = can('member', 'change-role');
  const { data: permissionsResponse } = tsr.listPermissions.useQuery({ queryKey: ['permissions'] });
  const catalog = permissionsResponse?.status === 200 ? permissionsResponse.body : [];
  const canManageOwners =
    catalog.length > 0 && catalog.every(({ resource, action }) => permissions.has(`${resource}:${action}`));
  const { systemRoles, customRoles } = useMemo(() => {
    const roles = rolesResponse?.status === 200 ? rolesResponse.body : [];
    const byName = (left: OrganizationMemberRole, right: OrganizationMemberRole) => left.name.localeCompare(right.name);
    return {
      systemRoles: roles.filter((role) => role.isSystem).sort(byName),
      customRoles: roles.filter((role) => !role.isSystem).sort(byName),
    };
  }, [rolesResponse]);

  if (!activeOrgId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Organization Selected</CardTitle>
          <CardDescription>Please select an organization to manage roles.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (isRolesLoading) {
    return <BootScreen />;
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Roles &amp; Permissions</h2>
            <p className="text-muted-foreground text-sm">Manage system and custom roles for your organization.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/organizations/roles/permissions">
                <Shield className="mr-2 h-4 w-4" />
                View All Permissions
              </Link>
            </Button>
            {canManageRoles && (
              <Button asChild>
                <Link to="/organizations/roles/create">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Custom Role
                </Link>
              </Button>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-muted-foreground mb-3 text-sm font-medium">System Roles</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {systemRoles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                canManage={canManageRoles && (!role.isOwnerCapable || canManageOwners)}
                isSystem
              />
            ))}
          </div>
        </div>

        {customRoles.length > 0 && (
          <div>
            <h3 className="text-muted-foreground mb-3 text-sm font-medium">Custom Roles</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {customRoles.map((role) => (
                <RoleCard
                  key={role.id}
                  role={role}
                  canManage={canManageRoles && (!role.isOwnerCapable || canManageOwners)}
                  isSystem={false}
                />
              ))}
            </div>
          </div>
        )}

        {customRoles.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Shield className="text-muted-foreground/50 mb-4 h-12 w-12" />
              <p className="text-muted-foreground text-sm">
                No custom roles yet. Create one or clone a system role to get started.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
      <Outlet />
    </>
  );
}

function RoleCard({
  role,
  canManage,
  isSystem,
}: {
  role: OrganizationMemberRole;
  canManage: boolean;
  isSystem: boolean;
}) {
  const permissionCount = role.rolePermissions.length;
  const memberCount = role._count.members;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {isSystem && <Lock className="text-muted-foreground h-4 w-4" />}
            <CardTitle className="text-base">{role.name}</CardTitle>
          </div>
          <div className="flex gap-1">
            {role.templateId && (
              <Badge variant="outline" className="text-xs">
                Cloned
              </Badge>
            )}
          </div>
        </div>
        {role.description && <CardDescription className="text-xs">{role.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-muted-foreground flex gap-3 text-xs">
          <span>
            {permissionCount} permission{permissionCount !== 1 ? 's' : ''}
          </span>
          <span>&middot;</span>
          <span>
            {memberCount} member{memberCount !== 1 ? 's' : ''}
          </span>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {isSystem ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/organizations/roles/create" search={{ cloneFrom: role.id }}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Clone
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/organizations/roles/edit/$roleId" params={{ roleId: role.id }}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" />
                    Edit
                  </Link>
                </Button>
                <Button variant="outline" size="sm" className="text-destructive" asChild>
                  <Link
                    to="/organizations/roles/edit/$roleId"
                    params={{ roleId: role.id }}
                    search={{ action: 'archive' }}
                  >
                    <Archive className="mr-1.5 h-3.5 w-3.5" />
                    Archive
                  </Link>
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
