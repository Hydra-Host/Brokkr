import type { IpRange } from '@repo/api-client';

import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

function statusVariant(status: string) {
  switch (status) {
    case 'ACTIVE':
      return 'default';
    case 'RESERVED':
      return 'secondary';
    case 'DEPRECATED':
      return 'destructive';
    default:
      return 'outline';
  }
}

const columns: ServerColumnDef<IpRange>[] = [
  {
    id: 'range',
    header: 'Range',
    size: 280,
    cell: ({ row }) => (
      <span className="font-mono text-sm">
        {row.original.start} - {row.original.end}
      </span>
    ),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 120,
    cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>,
  },
  {
    id: 'purpose',
    accessorKey: 'purpose',
    header: 'Purpose',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.purpose || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/ipam/ip-ranges/')({
  staticData: { breadcrumb: 'IP Ranges' },
  component: IpRangesPage,
});

function IpRangesPage() {
  useDocumentTitle('IP Ranges');
  const navigate = useNavigate();
  const table = useServerTable<IpRange>({ name: 'ip-ranges', columns });

  const ipRangesQuery = tsr.listIpRanges.useQuery({
    queryKey: ['ip-ranges'],
    queryData: { query: {} },
  });

  const rows = ipRangesQuery.data?.status === 200 ? ipRangesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>IP Ranges</CardTitle>
              <CardDescription>Manage IP address ranges.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/ip-ranges/create">Create IP Range</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={ipRangesQuery.isPending}
            searchPlaceholder="Search IP ranges..."
            searchLabel="Search IP ranges"
            emptyMessage="No IP ranges found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/ip-ranges/$ipRangeId',
                params: { ipRangeId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
