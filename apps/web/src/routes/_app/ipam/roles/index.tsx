import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface IpamRole {
  id: string;
  name: string;
  slug: string;
  weight: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<IpamRole>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
  },
  {
    id: 'slug',
    accessorKey: 'slug',
    header: 'Slug',
    size: 200,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.slug}</span>,
  },
  {
    id: 'weight',
    accessorKey: 'weight',
    header: 'Weight',
    size: 100,
    cell: ({ row }) => <span className="text-sm">{row.original.weight}</span>,
  },
  {
    id: 'description',
    accessorKey: 'description',
    header: 'Description',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.description || <span className="text-muted-foreground">--</span>}</span>
    ),
  },
  {
    id: 'createdAt',
    header: 'Created',
    sortField: 'createdAt',
    breakpoint: 'desktop',
    size: 110,
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
];

export const Route = createFileRoute('/_app/ipam/roles/')({
  staticData: { breadcrumb: 'IPAM Roles' },
  component: IpamRolesPage,
});

function IpamRolesPage() {
  useDocumentTitle('IPAM Roles');
  const navigate = useNavigate();
  const table = useServerTable<IpamRole>({ name: 'ipam-roles', columns });

  const rolesQuery = tsr.listIpamRoles.useQuery({
    queryKey: ['ipam-roles'],
    queryData: { query: {} },
  });

  const rows = rolesQuery.data?.status === 200 ? rolesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>IPAM Roles</CardTitle>
              <CardDescription>Manage roles for prefixes and VLANs.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/roles/create">Create Role</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={rolesQuery.isPending}
            searchPlaceholder="Search roles..."
            searchLabel="Search roles"
            emptyMessage="No IPAM roles found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/roles/$roleId',
                params: { roleId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
