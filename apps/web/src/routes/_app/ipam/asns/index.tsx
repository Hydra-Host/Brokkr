import type { Asn } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<Asn>[] = [
  {
    id: 'asn',
    accessorKey: 'asn',
    header: 'ASN',
    sortField: 'asn',
    size: 120,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.asn}</span>,
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

export const Route = createFileRoute('/_app/ipam/asns/')({
  staticData: { breadcrumb: 'ASNs' },
  component: AsnsPage,
});

function AsnsPage() {
  useDocumentTitle('ASNs');
  const navigate = useNavigate();
  const table = useServerTable<Asn>({ name: 'asns', columns });

  const asnsQuery = tsr.listAsns.useQuery({
    queryKey: ['asns'],
    queryData: { query: {} },
  });

  const rows = asnsQuery.data?.status === 200 ? asnsQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>ASNs</CardTitle>
              <CardDescription>Manage Autonomous System Numbers.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/asns/create">Create ASN</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={asnsQuery.isPending}
            searchPlaceholder="Search ASNs..."
            searchLabel="Search ASNs"
            emptyMessage="No ASNs found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/asns/$asnId',
                params: { asnId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
