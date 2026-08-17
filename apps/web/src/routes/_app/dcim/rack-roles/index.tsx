import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { tsr } from '~/lib/api';

type RackRoleRow = {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const columns: ServerColumnDef<RackRoleRow>[] = [
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
    size: 150,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.slug}</span>,
  },
  {
    id: 'color',
    accessorKey: 'color',
    header: 'Color',
    size: 100,
    cell: ({ row }) =>
      row.original.color ? (
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: row.original.color }} />
          <span className="font-mono text-xs">{row.original.color}</span>
        </div>
      ) : (
        <span className="text-muted-foreground text-sm">--</span>
      ),
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

export const Route = createFileRoute('/_app/dcim/rack-roles/')({
  component: RackRolesPage,
});

function RackRolesPage() {
  useDocumentTitle('Rack Roles');
  const navigate = useNavigate();
  const table = useServerTable<RackRoleRow>({ name: 'rack-roles', columns });
  const { isInstanceOperator } = useIsInstanceOperator();

  const query = tsr.listDcimRackRoles.useQuery({
    queryKey: ['dcim-rack-roles'],
    queryData: { query: {} },
  });

  const rows = query.data?.status === 200 ? query.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Rack Roles</CardTitle>
              <CardDescription>Manage rack roles for organizing racks.</CardDescription>
            </div>
            {isInstanceOperator && (
              <Button asChild>
                <Link to="/dcim/rack-roles/create">Create Rack Role</Link>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={query.isPending}
            searchPlaceholder="Search rack roles..."
            searchLabel="Search rack roles"
            emptyMessage="No rack roles found"
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/rack-roles/$roleId',
                params: { roleId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
