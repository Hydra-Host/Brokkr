import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, useLocation } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, UserPlus } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import type { Invitation, OrganizationMemberRole, OrganizationMemberWithUser } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { DataTable, DataTableSortHeader } from '@repo/ui/components/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { ServerPagination } from '@repo/ui/components/server-pagination';
import { FormCombobox } from '@repo/ui/form/form-combobox';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { usePagination } from '@repo/ui/hooks/use-pagination';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { formatShortDate, getRoleBadgeVariant, unwrapErrorMessage } from '@repo/utils';
import { BootScreen } from '~/components/boot-screen';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';
import { getOwnerManagementAvailability, type OwnerManagementAvailability } from '~/lib/owner-management';

export const Route = createFileRoute('/_app/organizations/members')({
  staticData: { breadcrumb: 'Members', description: 'Invite and manage team members and their roles' },
  component: MembersPage,
});

const ALL_ROLES_FILTER_VALUE = '__all__';

type OwnerAction =
  | { type: 'grant'; member: OrganizationMemberWithUser }
  | { type: 'revoke'; member: OrganizationMemberWithUser }
  | { type: 'transfer'; member: OrganizationMemberWithUser };

function MembersPage() {
  useDocumentTitle('Organization Members');
  const { data: session } = useSession();
  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId;
  const location = useLocation();

  const { can, permissions } = usePermissions();
  const canManageMembers = can('member', 'change-role');
  const [ownerAction, setOwnerAction] = useState<OwnerAction | null>(null);

  const {
    data: rolesResponse,
    isLoading: isRolesLoading,
    isError: rolesFailed,
  } = tsr.listOrganizationRoles.useQuery({
    queryKey: ['organization-roles', activeOrgId],
    enabled: !!activeOrgId,
  });
  const availableRoles = useMemo(() => (rolesResponse?.status === 200 ? rolesResponse.body : []), [rolesResponse]);

  const {
    data: permissionsResponse,
    isLoading: isPermissionsLoading,
    isError: permissionsFailed,
  } = tsr.listPermissions.useQuery({
    queryKey: ['permissions'],
    enabled: !!activeOrgId,
  });
  const catalog = permissionsResponse?.status === 200 ? permissionsResponse.body : [];
  const isOwnerCapableActor =
    catalog.length > 0 && catalog.every(({ resource, action }) => permissions.has(`${resource}:${action}`));
  const assignableOwnerRoles = useMemo(
    () =>
      availableRoles.filter(
        (role) =>
          role.isOwnerCapable &&
          role.rolePermissions.every(({ permission }) =>
            permissions.has(`${permission.resource}:${permission.action}`),
          ),
      ),
    [availableRoles, permissions],
  );

  const ownerManagementAvailability = getOwnerManagementAvailability({
    isLoading: isRolesLoading || isPermissionsLoading,
    loadFailed: rolesFailed || permissionsFailed,
    isOwnerCapableActor,
    hasOwnerCapableRole: assignableOwnerRoles.length > 0,
  });

  const currentUserId = session?.user?.id;
  const columns = useMemo(
    () =>
      getMemberColumns(
        canManageMembers,
        ownerManagementAvailability,
        currentUserId,
        permissions,
        availableRoles,
        setOwnerAction,
      ),
    [canManageMembers, ownerManagementAvailability, currentUserId, permissions, availableRoles],
  );
  const table = useServerTable<OrganizationMemberWithUser>({
    name: 'org-members',
    columns,
  });

  const rolesLoaded = rolesResponse !== undefined;
  const urlParams = new URLSearchParams(location.searchStr);
  const assignedRoleIdParam = urlParams.get('assignedRoleId');
  const assignedRoleIdFilter =
    assignedRoleIdParam && (!rolesLoaded || availableRoles.some((r) => r.id === assignedRoleIdParam))
      ? assignedRoleIdParam
      : ALL_ROLES_FILTER_VALUE;

  const handleRoleFilterChange = (value: string) => {
    table.updateSearch((prev) => ({
      ...prev,
      assignedRoleId: value !== ALL_ROLES_FILTER_VALUE ? value : undefined,
      page: undefined,
    }));
  };

  const queryParams = {
    ...table.query,
    assignedRoleId: assignedRoleIdFilter !== ALL_ROLES_FILTER_VALUE ? assignedRoleIdFilter : undefined,
  };

  const selectedRoleName = availableRoles.find((r) => r.id === assignedRoleIdFilter)?.name;

  const {
    data: memberships,
    isLoading: isMembershipsLoading,
    isFetching: isMembershipsFetching,
  } = tsr.getOrganizationMemberships.useQuery({
    queryKey: ['memberships', activeOrgId, queryParams],
    queryData: { query: queryParams },
    enabled: !!activeOrgId,
    placeholderData: keepPreviousData,
  });

  const invitationsPagination = usePagination({ defaultPageSize: 20 });

  const { data: invitations, isLoading: isInvitationsLoading } = tsr.listInvitations.useQuery({
    queryKey: ['invitations', activeOrgId, invitationsPagination.page, invitationsPagination.pageSize],
    queryData: { query: { page: invitationsPagination.page, pageSize: invitationsPagination.pageSize } },
    enabled: !!activeOrgId,
    placeholderData: keepPreviousData,
  });

  if (!activeOrgId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Organization Selected</CardTitle>
          <CardDescription>Please select an organization to manage members.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (isMembershipsLoading || isInvitationsLoading) {
    return <BootScreen />;
  }

  const membersData = memberships?.status === 200 ? memberships.body.data : [];
  const membersMeta = memberships?.status === 200 ? memberships.body.meta : undefined;
  const invitationsList = invitations?.status === 200 ? invitations.body.data : [];
  const invitationsMeta = invitations?.status === 200 ? invitations.body.meta : undefined;
  const pendingInvitations = invitationsList.filter((inv) => inv.status === 'pending' || inv.status === 'expired');

  return (
    <>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-6">
            <div className="space-y-1">
              <CardTitle>Members</CardTitle>
              <CardDescription>Manage your organization&apos;s members and their roles.</CardDescription>
            </div>
            {canManageMembers && (
              <Button asChild>
                <Link to="/organizations/members/invite">
                  <Plus className="mr-2 h-4 w-4" />
                  Invite Member
                </Link>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <ServerDataTable
              table={table}
              data={membersData}
              meta={membersMeta}
              isPending={isMembershipsLoading}
              isFetching={isMembershipsFetching && !isMembershipsLoading}
              searchPlaceholder="Search members..."
              searchLabel="Search members"
              emptyMessage="No members found"
              toolbar={
                <Select value={assignedRoleIdFilter} onValueChange={handleRoleFilterChange}>
                  <SelectTrigger className="h-10 w-[180px]" aria-label="Filter by role">
                    <span>
                      {assignedRoleIdFilter === ALL_ROLES_FILTER_VALUE ? 'All Roles' : (selectedRoleName ?? 'Unknown')}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_ROLES_FILTER_VALUE}>All Roles</SelectItem>
                    {availableRoles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </CardContent>
        </Card>

        {canManageMembers && pendingInvitations.length > 0 && (
          <InvitationsTable
            invitations={pendingInvitations}
            meta={invitationsMeta}
            onPageChange={invitationsPagination.setPage}
            pageSize={invitationsPagination.pageSize}
            onPageSizeChange={invitationsPagination.setPageSize}
          />
        )}
      </div>
      <OwnerManagementDialog
        action={ownerAction}
        organizationId={activeOrgId}
        roles={availableRoles}
        ownerRoles={assignableOwnerRoles}
        onClose={() => setOwnerAction(null)}
      />
      <Outlet />
    </>
  );
}

function getMemberColumns(
  canManageMembers: boolean,
  ownerManagementAvailability: OwnerManagementAvailability,
  currentUserId: string | undefined,
  actorPermissions: Set<string>,
  availableRoles: OrganizationMemberRole[],
  setOwnerAction: (action: OwnerAction) => void,
): ServerColumnDef<OrganizationMemberWithUser>[] {
  return [
    {
      id: 'user',
      header: 'Member',
      sortField: 'name',
      accessorFn: (row) => row.user.name || row.user.email,
      cell: ({ row }) => <span className="font-medium">{row.original.user.name || 'Unnamed User'}</span>,
    },
    {
      id: 'email',
      header: 'Email',
      sortField: 'email',
      breakpoint: 'tablet',
      accessorFn: (row) => row.user.email,
      cell: ({ row }) => <span className="text-muted-foreground text-sm">{row.original.user.email}</span>,
    },
    {
      id: 'role',
      header: 'Role',
      sortField: 'role',
      noTruncate: true,
      size: 60,
      accessorFn: (row) => row.role,
      cell: ({ row }) => {
        const member = row.original;
        const assignedRole = availableRoles.find((role) => role.id === member.assignedRoleId);
        const targetPermissions = new Set(
          assignedRole?.rolePermissions.map(({ permission }) => `${permission.resource}:${permission.action}`) ?? [],
        );
        const strictlyDominates =
          Array.from(targetPermissions).every((permission) => actorPermissions.has(permission)) &&
          Array.from(actorPermissions).some((permission) => !targetPermissions.has(permission));
        const canEdit =
          canManageMembers && !assignedRole?.isOwnerCapable && (member.userId === currentUserId || strictlyDominates);
        if (!canManageMembers) {
          return <Badge variant={getRoleBadgeVariant(member.role)}>{member.role}</Badge>;
        }
        return canEdit ? (
          <RoleCell member={member} availableRoles={availableRoles} />
        ) : (
          <Badge variant={getRoleBadgeVariant(member.role)}>{member.role}</Badge>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: 'Joined',
      sortField: 'createdAt',
      breakpoint: 'desktop',
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{formatShortDate(row.original.createdAt)}</span>
      ),
    },
    ...(canManageMembers
      ? [
          {
            id: 'actions',
            size: 48,
            header: '',
            noTruncate: true,
            cell: ({ row }: { row: { original: OrganizationMemberWithUser } }) => {
              const member = row.original;
              const assignedRole = availableRoles.find((role) => role.id === member.assignedRoleId);
              const isOwner = assignedRole?.isOwnerCapable === true;
              const canRemove = !isOwner && member.userId !== currentUserId;
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      aria-label={`Actions for ${member.user.email}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {ownerManagementAvailability.state !== 'ready' && (
                      <DropdownMenuItem disabled>{ownerManagementAvailability.message}</DropdownMenuItem>
                    )}
                    {ownerManagementAvailability.state === 'ready' && !isOwner && (
                      <DropdownMenuItem onClick={() => setOwnerAction({ type: 'grant', member })}>
                        Grant owner access
                      </DropdownMenuItem>
                    )}
                    {ownerManagementAvailability.state === 'ready' && isOwner && (
                      <>
                        <DropdownMenuItem onClick={() => setOwnerAction({ type: 'revoke', member })}>
                          Remove owner access
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setOwnerAction({ type: 'transfer', member })}>
                          Transfer ownership
                        </DropdownMenuItem>
                      </>
                    )}
                    {canRemove && (
                      <DropdownMenuItem asChild className="text-destructive">
                        <Link
                          to="/organizations/members/remove/$membershipId"
                          params={{ membershipId: row.original.id }}
                          className="w-full"
                        >
                          Remove Member
                        </Link>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            },
          } satisfies ServerColumnDef<OrganizationMemberWithUser>,
        ]
      : []),
  ];
}

function RoleCell({
  member,
  availableRoles,
}: {
  member: OrganizationMemberWithUser;
  availableRoles: OrganizationMemberRole[];
}) {
  const queryClient = useQueryClient();
  const { mutateAsync: assignRole, isPending } = tsr.assignRoleToMember.useMutation();

  const NO_ROLE_VALUE = '__none__';

  const options = useMemo(
    () => availableRoles.filter((role) => !role.isOwnerCapable).map((role) => ({ label: role.name, value: role.id })),
    [availableRoles],
  );

  const form = useForm<{ roleId: string }>({
    defaultValues: { roleId: member.assignedRoleId ?? NO_ROLE_VALUE },
  });

  useEffect(() => {
    form.reset({ roleId: member.assignedRoleId ?? NO_ROLE_VALUE });
  }, [member.assignedRoleId, form]);

  const handleRoleChange = async (value: string) => {
    if (value === NO_ROLE_VALUE) return;
    try {
      const response = await assignRole({
        params: { memberId: member.id },
        body: { roleId: value },
      });
      if (response.status !== 200) {
        throw new Error(unwrapErrorMessage(response, 'Failed to update role'));
      }
      const newLabel = availableRoles.find((r) => r.id === value)?.name ?? 'new role';
      toast.success(`Role updated to ${newLabel}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['organizations'] }),
      ]);
    } catch (error) {
      form.reset({ roleId: member.assignedRoleId ?? NO_ROLE_VALUE });
      toast.error(unwrapErrorMessage(error, 'Failed to update role'));
    }
  };

  return (
    <FormSelect
      control={form.control}
      name="roleId"
      label="Role"
      options={member.assignedRoleId ? options : [{ label: 'No role assigned', value: NO_ROLE_VALUE }, ...options]}
      disabled={isPending || options.length === 0}
      className="[&_label]:sr-only"
      triggerClassName="h-8 w-[160px]"
      onValueChange={handleRoleChange}
    />
  );
}

function OwnerManagementDialog({
  action,
  organizationId,
  roles,
  ownerRoles,
  onClose,
}: {
  action: OwnerAction | null;
  organizationId: string;
  roles: OrganizationMemberRole[];
  ownerRoles: OrganizationMemberRole[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [recipientSearch, setRecipientSearch] = useState('');
  const [recipientPage, setRecipientPage] = useState(1);
  const [recipientPageSize, setRecipientPageSize] = useState(20);
  const [selectedRecipientOption, setSelectedRecipientOption] = useState<{ label: string; value: string }>();
  const deferredRecipientSearch = useDeferredValue(recipientSearch);
  const form = useForm<{
    ownerRoleId: string;
    replacementRoleId: string;
    recipientMemberId: string;
  }>({
    defaultValues: { ownerRoleId: '', replacementRoleId: '', recipientMemberId: '' },
  });
  const grant = tsr.grantOwnerAccess.useMutation();
  const revoke = tsr.revokeOwnerAccess.useMutation();
  const transfer = tsr.transferOwnership.useMutation();
  const isPending = grant.isPending || revoke.isPending || transfer.isPending;
  const ordinaryRoles = roles.filter((role) => !role.isOwnerCapable);
  const {
    data: recipientResponse,
    isLoading: recipientsLoading,
    isFetching: recipientsFetching,
    isError: recipientsFailed,
  } = tsr.getOrganizationMemberships.useQuery({
    queryKey: [
      'memberships',
      organizationId,
      'owner-recipient',
      deferredRecipientSearch,
      recipientPage,
      recipientPageSize,
    ],
    queryData: {
      query: {
        search: deferredRecipientSearch || undefined,
        page: recipientPage,
        pageSize: recipientPageSize,
        ownerTransferEligible: true,
        excludeMemberId: action?.member.id,
      },
    },
    enabled: action?.type === 'transfer',
    placeholderData: keepPreviousData,
  });
  const recipientMembers = recipientResponse?.status === 200 ? recipientResponse.body.data : [];
  const recipientMeta = recipientResponse?.status === 200 ? recipientResponse.body.meta : undefined;
  const pageRecipientOptions = useMemo(
    () => recipientMembers.map((member) => ({ label: member.user.name || member.user.email, value: member.id })),
    [recipientMembers],
  );
  const recipientOptions =
    selectedRecipientOption && !pageRecipientOptions.some((option) => option.value === selectedRecipientOption.value)
      ? [selectedRecipientOption, ...pageRecipientOptions]
      : pageRecipientOptions;

  useEffect(() => {
    form.reset({ ownerRoleId: '', replacementRoleId: '', recipientMemberId: '' });
    setError(undefined);
    setRecipientSearch('');
    setRecipientPage(1);
    setSelectedRecipientOption(undefined);
  }, [action, form]);

  const selectedOwnerRoleId = form.watch('ownerRoleId');
  const selectedReplacementRoleId = form.watch('replacementRoleId');
  const selectedRecipientMemberId = form.watch('recipientMemberId');
  useEffect(() => {
    const selected = pageRecipientOptions.find((option) => option.value === selectedRecipientMemberId);
    if (selected) setSelectedRecipientOption(selected);
  }, [pageRecipientOptions, selectedRecipientMemberId]);

  if (!action) return null;

  const missingRequiredSelection =
    (action.type !== 'revoke' && !selectedOwnerRoleId) ||
    (action.type !== 'grant' && !selectedReplacementRoleId) ||
    (action.type === 'transfer' && !selectedRecipientMemberId);

  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      if (action.type === 'grant') {
        const response = await grant.mutateAsync({
          params: { memberId: action.member.id },
          body: { roleId: values.ownerRoleId },
        });
        if (response.status !== 200) {
          throw new Error(unwrapErrorMessage(response, 'Failed to grant owner access'));
        }
        toast.success('Owner access granted');
      } else if (action.type === 'revoke') {
        const response = await revoke.mutateAsync({
          params: { memberId: action.member.id },
          body: { replacementRoleId: values.replacementRoleId },
        });
        if (response.status !== 200) {
          throw new Error(unwrapErrorMessage(response, 'Failed to remove owner access'));
        }
        toast.success('Owner access removed');
      } else {
        const response = await transfer.mutateAsync({
          body: {
            sourceMemberId: action.member.id,
            recipientMemberId: values.recipientMemberId,
            ownerRoleId: values.ownerRoleId,
            sourceReplacementRoleId: values.replacementRoleId,
          },
        });
        if (response.status !== 200) {
          throw new Error(unwrapErrorMessage(response, 'Failed to transfer ownership'));
        }
        toast.success('Ownership transferred');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['organization-roles'] }),
        queryClient.invalidateQueries({ queryKey: ['organizations'] }),
      ]);
      onClose();
    } catch (submitError) {
      setError(unwrapErrorMessage(submitError, 'Owner management failed'));
    }
  });

  const title =
    action.type === 'grant'
      ? 'Grant owner access'
      : action.type === 'revoke'
        ? 'Remove owner access'
        : 'Transfer ownership';
  const description =
    action.type === 'grant'
      ? `${action.member.user.email} will receive full control of this organization.`
      : action.type === 'revoke'
        ? `${action.member.user.email} will lose full control and receive the selected replacement role.`
        : `The recipient receives full control before ${action.member.user.email} is moved to the replacement role.`;

  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {action.type === 'transfer' && (
            <div className="space-y-2">
              <FormCombobox
                control={form.control}
                name="recipientMemberId"
                label="New owner"
                options={recipientOptions}
                placeholder="Search members"
                searchValue={recipientSearch}
                onSearchChange={(value) => {
                  setRecipientSearch(value);
                  setRecipientPage(1);
                }}
                shouldFilter={false}
                emptyMessage={
                  recipientsLoading || recipientsFetching
                    ? 'Loading members...'
                    : recipientsFailed
                      ? 'Unable to load members.'
                      : 'No eligible members found.'
                }
                disabled={isPending || recipientsLoading || recipientsFailed}
              />
              {recipientMeta && (
                <ServerPagination
                  meta={recipientMeta}
                  onPageChange={setRecipientPage}
                  pageSize={recipientPageSize}
                  onPageSizeChange={(pageSize) => {
                    setRecipientPageSize(pageSize);
                    setRecipientPage(1);
                  }}
                />
              )}
            </div>
          )}
          {action.type !== 'revoke' && (
            <FormSelect
              control={form.control}
              name="ownerRoleId"
              label="Owner role"
              options={ownerRoles.map((role) => ({ label: role.name, value: role.id }))}
              placeholder="Select an owner role"
              disabled={isPending}
            />
          )}
          {action.type !== 'grant' && (
            <FormSelect
              control={form.control}
              name="replacementRoleId"
              label="Replacement role"
              options={ordinaryRoles.map((role) => ({ label: role.name, value: role.id }))}
              placeholder="Select a non-owner role"
              disabled={isPending}
            />
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton
              pending={isPending}
              disabled={missingRequiredSelection}
              variant={action.type === 'grant' ? 'default' : 'destructive'}
            >
              {title}
            </FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InvitationsTable({
  invitations,
  meta,
  onPageChange,
  pageSize,
  onPageSizeChange,
}: {
  invitations: Invitation[];
  meta?: { page: number; pageSize: number; totalItems: number; totalPages: number };
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  const columns: ColumnDef<Invitation>[] = useMemo(
    () => [
      {
        accessorKey: 'email',
        header: ({ column }) => <DataTableSortHeader column={column} label="Email" />,
        cell: ({ row }) => <span className="font-medium">{row.original.email}</span>,
      },
      {
        accessorKey: 'role',
        header: ({ column }) => <DataTableSortHeader column={column} label="Role" />,
        cell: ({ row }) => (
          <Badge variant="outline" className="capitalize">
            {row.original.role}
          </Badge>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: ({ column }) => <DataTableSortHeader column={column} label="Sent" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{formatShortDate(row.original.createdAt)}</span>
        ),
      },
      {
        accessorKey: 'expiresAt',
        header: ({ column }) => <DataTableSortHeader column={column} label="Expires" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{formatShortDate(row.original.expiresAt)}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableSortHeader column={column} label="Status" />,
        cell: ({ row }) => {
          const isExpired = row.original.status === 'expired';
          return (
            <Badge variant={isExpired ? 'warning' : 'secondary'} className="capitalize">
              {row.original.status}
            </Badge>
          );
        },
      },
      {
        id: 'actions',
        size: 110,
        minSize: 110,
        noTruncate: true,
        header: () => (
          <div className="flex justify-end">
            <span className="sr-only">Actions</span>
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="text-destructive hover:text-destructive whitespace-nowrap"
            >
              <Link
                to="/organizations/members/cancel-invitation/$invitationId"
                params={{ invitationId: row.original.id }}
              >
                Cancel
              </Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5" />
          Pending Invitations
        </CardTitle>
        <CardDescription>
          Invitations that have been sent but not yet accepted. Expired invitations can no longer be accepted by the
          recipient — cancel them and send a new invite.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {meta && (
          <ServerPagination
            meta={meta}
            onPageChange={onPageChange}
            pageSize={pageSize}
            onPageSizeChange={onPageSizeChange}
          />
        )}
        <DataTable columns={columns} data={invitations} emptyMessage="No pending invitations" />
      </CardContent>
    </Card>
  );
}
