import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { ColumnDef } from '@tanstack/react-table';
import { formatDistance } from 'date-fns';
import { Clock, Edit, Folder, MoreVertical, Plus, Search, Server } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import type { Deployment, InterruptibleClaim, ReservationInviteForUser } from '@repo/api-client';
import { DeviceStatusBadge } from '@repo/domain-ui/components/device-status-badge';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { CountdownCell } from '@repo/ui/components/countdown-cell';
import { DataTable, DataTableSortHeader } from '@repo/ui/components/data-table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Input } from '@repo/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { cn, navigatePreservingSearch } from '@repo/ui/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { useDeploymentListEvents } from '~/hooks/use-device-events';
import { tsr } from '~/lib/api';
import { BRAND_NAME } from '~/lib/branding';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const searchSchema = z.object({
  project: z.string().optional(),
});

export const Route = createFileRoute('/_app/deployments/_list')({
  staticData: { breadcrumb: 'Deployments', description: 'View and manage your active GPU server deployments' },
  validateSearch: searchSchema,
  loader: async ({ context: { queryClient } }) => {
    const projectsResponse = await queryClient.fetchQuery({
      queryKey: DEPLOYMENT_PROJECTS_KEY,
      queryFn: () => tsr.getDeploymentProjects.query({ query: { pageSize: 100 } }),
    });

    if (projectsResponse.status !== 200) {
      throw new Error('Failed to load deployment projects');
    }

    return { projects: projectsResponse.body.data };
  },
  component: DeploymentsListLayout,
});

function getDeploymentColumns(): ColumnDef<Deployment>[] {
  return [
    {
      accessorKey: 'customer.deviceName',
      header: ({ column }) => <DataTableSortHeader column={column} label="Device Name" />,
      cell: ({ row }) => {
        const deployment = row.original;
        const displayName = deployment.customer?.deviceName || `Deployment ...${deployment.id.slice(-6)}`;
        return (
          <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
            <Link
              to="/deployments/$deploymentId"
              params={{ deploymentId: String(deployment.id) }}
              className="hover:text-primary font-medium underline"
            >
              {displayName}
            </Link>
            <span className="font-mono text-xs">{deployment.id}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'status.label',
      header: ({ column }) => <DataTableSortHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const label = row.original.status?.label;
        if (!label) return null;
        return <DeviceStatusBadge status={label} />;
      },
    },
    {
      accessorKey: 'networking.ipv4',
      header: ({ column }) => <DataTableSortHeader column={column} label="IPv4" />,
      cell: ({ row }) => {
        const ipv4 = row.original.networking?.ipv4;
        return ipv4 ? (
          <span className="font-mono text-sm">{ipv4}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      accessorKey: 'networking.ipv6',
      header: ({ column }) => <DataTableSortHeader column={column} label="IPv6" />,
      cell: ({ row }) => {
        const ipv6 = row.original.networking?.ipv6;
        return ipv6 ? (
          <span className="font-mono text-sm">{ipv6}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      accessorKey: 'isLocked',
      header: ({ column }) => <DataTableSortHeader column={column} label="Locked" />,
      cell: ({ row }) => (row.original.isLocked ? <Badge>Locked</Badge> : <Badge variant="secondary">Unlocked</Badge>),
    },
  ];
}

const interruptibleClaimColumns: ServerColumnDef<InterruptibleClaim>[] = [
  {
    accessorKey: 'deviceId',
    header: 'Device ID',
    cell: ({ row }) => <span className="font-semibold">{row.original.deviceId}</span>,
  },
  {
    accessorKey: 'deploymentName',
    header: 'Deployment Name',
    cell: ({ row }) => <span className="font-semibold">{row.original.deploymentName}</span>,
  },
  {
    accessorKey: 'interruptAt',
    header: 'Interrupts In',
    cell: ({ row }) => {
      const interruptAt = row.original.interruptAt;
      if (!interruptAt) return '-';
      return <CountdownCell endTime={interruptAt} />;
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    size: 120,
    cell: ({ row }) => <Badge variant="warning">{row.original.status}</Badge>,
  },
];

const reservationInviteColumns: ServerColumnDef<ReservationInviteForUser>[] = [
  {
    accessorKey: 'listing.name',
    header: 'Device Name',
    cell: ({ row }) => <span className="font-semibold">{row.original.listing?.name || '-'}</span>,
  },
  {
    id: 'specs',
    header: 'Specifications',
    cell: ({ row }) => {
      const listing = row.original.listing;
      if (!listing) return '-';
      return (
        <span className="text-muted-foreground text-sm">
          {listing.specs?.cpu?.cores || 0} Cores &middot; {listing.specs?.memory || 0}GB RAM &middot;{' '}
          {listing.specs?.gpu?.model || 'No GPU'}
        </span>
      );
    },
  },
  {
    accessorKey: 'dateExpires',
    header: 'Expires',
    cell: ({ row }) => {
      const expiryDate = row.original.dateExpires;
      if (!expiryDate) return '-';
      return (
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span className="text-sm">{formatDistance(new Date(expiryDate), new Date(), { addSuffix: true })}</span>
        </div>
      );
    },
  },
  {
    id: 'actions',
    header: '',
    size: 120,
    cell: ({ row }) => {
      const deviceId = row.original.listing?.deviceId;
      if (!deviceId) return null;
      return (
        <Button size="sm" variant="outline" asChild>
          <Link to="/inventory/$deviceId" params={{ deviceId }}>
            Redeem Invite
          </Link>
        </Button>
      );
    },
  },
];

function ReservationInvitesSection() {
  const table = useServerTable<ReservationInviteForUser>({
    name: 'reservation-invites',
    columns: reservationInviteColumns,
  });

  const { data, isPending, isFetching } = tsr.getReservationInvites.useQuery({
    queryKey: ['reservation-invites', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const allInvites = data?.status === 200 ? data.body.data : [];
  const meta = data?.status === 200 ? data.body.meta : undefined;
  const validInvites = allInvites.filter((r) => r.listing);

  if (isPending || (!isFetching && validInvites.length === 0 && !table.search)) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reservation Invites</CardTitle>
        <CardDescription>Your current device invites in the {BRAND_NAME} inventory.</CardDescription>
      </CardHeader>
      <CardContent>
        <ServerDataTable
          table={table}
          data={validInvites}
          meta={meta}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          searchPlaceholder="Search invites..."
          searchLabel="Search invites"
          emptyMessage="No invites"
        />
      </CardContent>
    </Card>
  );
}

function InterruptibleClaimsSection() {
  const table = useServerTable<InterruptibleClaim>({
    name: 'interruptible-claims',
    columns: interruptibleClaimColumns,
  });

  const queryParams = { ...table.query, status: 'Pending' as const };

  const { data, isPending, isFetching } = tsr.getInterruptibleClaims.useQuery({
    queryKey: ['interruptible-claims', queryParams],
    queryData: { query: queryParams },
    placeholderData: keepPreviousData,
  });

  const claims = data?.status === 200 ? data.body.data : [];
  const meta = data?.status === 200 ? data.body.meta : undefined;

  if (isPending || (!isFetching && claims.length === 0 && !table.search)) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending Interruptible Claims</CardTitle>
        <CardDescription>Devices you have claimed that are waiting to be provisioned.</CardDescription>
      </CardHeader>
      <CardContent>
        <ServerDataTable
          table={table}
          data={claims}
          meta={meta}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          searchPlaceholder="Search claims..."
          searchLabel="Search claims"
          emptyMessage="No pending claims"
        />
      </CardContent>
    </Card>
  );
}

function ProjectSidebar({
  projects,
  totalProjectCount,
  selectedProjectId,
  onSelectProject,
  projectFilter,
  onProjectFilterChange,
}: {
  projects: Array<{ id: string; name: string; isDefault: boolean; deployments: Deployment[] }>;
  totalProjectCount: number;
  selectedProjectId: string | undefined;
  onSelectProject: (id: string) => void;
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
}) {
  return (
    <div className="sticky top-4 flex w-56 shrink-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide">Projects</h2>
        <Button variant="default" size="sm" asChild>
          <Link to="/deployments/projects/create">
            <Plus className="mr-1 h-4 w-4" />
            New
          </Link>
        </Button>
      </div>

      {totalProjectCount > 5 && (
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            type="text"
            placeholder="Filter..."
            value={projectFilter}
            onChange={(e) => onProjectFilterChange(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
      )}

      <nav className="flex flex-col gap-0.5">
        {projects.map((project) => {
          const isSelected = selectedProjectId === project.id;
          return (
            <button
              key={project.id}
              onClick={() => onSelectProject(project.id)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                'transition-all duration-200 ease-out',
                'hover:translate-x-1',
                isSelected
                  ? 'bg-accent text-primary-foreground translate-x-1 font-medium'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Folder className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {project.isDefault && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'px-1 py-0 text-[10px] leading-tight',
                      isSelected && 'border-primary-foreground/40 text-primary-foreground',
                    )}
                  >
                    Default
                  </Badge>
                )}
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {project.deployments.length}
                </span>
              </div>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function MobileProjectSelector({
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  projects: Array<{ id: string; name: string; isDefault: boolean; deployments: Deployment[] }>;
  selectedProjectId: string | undefined;
  onSelectProject: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select value={selectedProjectId || ''} onValueChange={onSelectProject}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select a project">
            {projects.find((p) => p.id === selectedProjectId)?.name || 'Select a project'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name} ({project.deployments.length}){project.isDefault ? ' - Default' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" asChild className="shrink-0">
        <Link to="/deployments/projects/create">
          <Plus className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  );
}

function DeploymentsListLayout() {
  useDocumentTitle('Deployments');
  useDeploymentListEvents();
  const { projects } = Route.useLoaderData();
  const { project: selectedProjectId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const [projectFilter, setProjectFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const filteredProjects = useMemo(() => {
    if (!projectFilter.trim()) return projects;
    const lower = projectFilter.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(lower));
  }, [projects, projectFilter]);

  const defaultProject = projects.find((p) => p.isDefault) || projects[0];
  const activeProjectId = selectedProjectId || defaultProject?.id;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const filteredDeployments = useMemo(() => {
    if (!activeProject) return [];
    if (!searchTerm.trim()) return activeProject.deployments;

    const lower = searchTerm.toLowerCase();
    return activeProject.deployments.filter((d) => {
      const fields = [
        String(d.id || ''),
        d.status?.label || '',
        d.customer?.deviceName || '',
        d.networking?.ipv4 || '',
        d.networking?.ipv6 || '',
        d.specs?.operating_system || '',
        d.location || '',
      ];
      return fields.some((f) => f.toLowerCase().includes(lower));
    });
  }, [activeProject, searchTerm]);

  const handleSelectProject = (id: string) => {
    navigate({ search: { project: id } });
    setSearchTerm('');
  };

  const columns = useMemo(() => getDeploymentColumns(), []);

  const totalDeployments = projects.reduce((acc, p) => acc + p.deployments.length, 0);

  return (
    <>
      <div className="space-y-6">
        <ReservationInvitesSection />

        <InterruptibleClaimsSection />

        {totalDeployments === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Server className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="mb-2 text-lg font-semibold">No deployments yet</h3>
              <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
                Build on the world&apos;s leading bare metal infrastructure with {BRAND_NAME} inventory.
              </p>
              <Button asChild>
                <Link to="/inventory">View Inventory</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {totalDeployments > 0 && (
          <div className="flex gap-4">
            <div className="hidden lg:block">
              <ProjectSidebar
                projects={filteredProjects}
                totalProjectCount={projects.length}
                selectedProjectId={activeProjectId}
                onSelectProject={handleSelectProject}
                projectFilter={projectFilter}
                onProjectFilterChange={setProjectFilter}
              />
            </div>

            <Card className="min-w-0 flex-1">
              <CardHeader className="pb-4">
                <div className="mb-2 lg:hidden">
                  <MobileProjectSelector
                    projects={projects}
                    selectedProjectId={activeProjectId}
                    onSelectProject={handleSelectProject}
                  />
                </div>

                {activeProject && (
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-lg">{activeProject.name}</CardTitle>
                      <Badge variant="secondary">
                        {activeProject.deployments.length} deployment
                        {activeProject.deployments.length !== 1 ? 's' : ''}
                      </Badge>
                      {activeProject.isDefault && <Badge variant="outline">Default</Badge>}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link to="/deployments/projects/$projectId/edit" params={{ projectId: activeProject.id }}>
                            <Edit className="mr-2 h-4 w-4" />
                            Edit Project
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild className="text-destructive">
                          <Link to="/deployments/projects/$projectId/delete" params={{ projectId: activeProject.id }}>
                            <Server className="mr-2 h-4 w-4" />
                            Delete Project
                          </Link>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                <div className="mb-4 flex items-center gap-4">
                  <div className="relative">
                    <Search className="text-muted-foreground absolute top-1/2 left-2 z-10 h-4 w-4 -translate-y-1/2" />
                    <Input
                      type="text"
                      placeholder="Search deployments..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="h-9 w-full pl-8 sm:w-[200px] lg:w-[300px]"
                    />
                  </div>
                  {searchTerm && (
                    <span className="text-muted-foreground hidden text-sm sm:inline">
                      {filteredDeployments.length} result{filteredDeployments.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                <DataTable
                  columns={columns}
                  data={filteredDeployments}
                  emptyMessage={
                    searchTerm ? `No deployments matching "${searchTerm}"` : 'No deployments in this project'
                  }
                  onRowClick={(row) => {
                    navigatePreservingSearch(navigate, {
                      to: '/deployments/deployment-details',
                      search: (prev) => ({ ...prev, deploymentId: String(row.id), project: activeProjectId }),
                    });
                  }}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Outlet />
    </>
  );
}
