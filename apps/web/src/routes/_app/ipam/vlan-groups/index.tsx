import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

interface VlanGroupRecord {
  id: string;
  name: string;
  description: string | null;
  minVid: number;
  maxVid: number;
  zoneId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const columns: ServerColumnDef<VlanGroupRecord>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    size: 200,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
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
    id: 'minVid',
    accessorKey: 'minVid',
    header: 'Min VID',
    size: 100,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.minVid}</span>,
  },
  {
    id: 'maxVid',
    accessorKey: 'maxVid',
    header: 'Max VID',
    size: 100,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.maxVid}</span>,
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

export const Route = createFileRoute('/_app/ipam/vlan-groups/')({
  staticData: { breadcrumb: 'VLAN Groups' },
  component: VlanGroupsPage,
});

function VlanGroupsPage() {
  useDocumentTitle('VLAN Groups');
  const navigate = useNavigate();
  const table = useServerTable<VlanGroupRecord>({ name: 'vlan-groups', columns });

  const vlanGroupsQuery = tsr.listVlanGroups.useQuery({
    queryKey: ['vlan-groups'],
    queryData: { query: {} },
  });

  const rows = vlanGroupsQuery.data?.status === 200 ? vlanGroupsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>VLAN Groups</CardTitle>
              <CardDescription>Manage VLAN groups for organizing VLANs.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/vlan-groups/create">Create VLAN Group</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={vlanGroupsQuery.isPending}
            searchPlaceholder="Search VLAN groups..."
            searchLabel="Search VLAN groups"
            emptyMessage="No VLAN groups found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/vlan-groups/$vlanGroupId',
                params: { vlanGroupId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
