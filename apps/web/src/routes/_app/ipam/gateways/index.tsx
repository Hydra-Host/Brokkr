import type { Gateway } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

const columns: ServerColumnDef<Gateway>[] = [
  {
    id: 'gatewayIp',
    header: 'Gateway IP',
    size: 200,
    cell: ({ row }) => (
      <Link
        to="/ipam/ip-addresses/$ipAddressId"
        params={{ ipAddressId: row.original.gatewayIpId }}
        className="font-mono text-sm hover:underline"
      >
        {row.original.gatewayIp.address}
      </Link>
    ),
  },
  {
    id: 'prefix',
    header: 'Prefix',
    size: 200,
    cell: ({ row }) => (
      <Link
        to="/ipam/prefixes/$prefixId"
        params={{ prefixId: row.original.prefixId }}
        className="font-mono text-sm hover:underline"
      >
        {row.original.prefix.prefix}
      </Link>
    ),
  },
  {
    id: 'vrf',
    header: 'VRF',
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.vrf ? row.original.vrf.name : <span className="text-muted-foreground">Global</span>}
      </span>
    ),
  },
  {
    id: 'routingPriority',
    accessorKey: 'routingPriority',
    header: 'Routing Priority',
    size: 130,
    cell: ({ row }) => (
      <span className="text-sm">
        {row.original.routingPriority ?? <span className="text-muted-foreground">--</span>}
      </span>
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

export const Route = createFileRoute('/_app/ipam/gateways/')({
  staticData: { breadcrumb: 'Gateways' },
  component: GatewaysPage,
});

function GatewaysPage() {
  useDocumentTitle('Gateways');
  const navigate = useNavigate();
  const table = useServerTable<Gateway>({ name: 'gateways', columns });

  const gatewaysQuery = tsr.listGateways.useQuery({
    queryKey: ['gateways'],
    queryData: { query: {} },
  });

  const rows = gatewaysQuery.data?.status === 200 ? gatewaysQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Gateways</CardTitle>
              <CardDescription>Manage IPAM gateways.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/gateways/create">Create Gateway</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={gatewaysQuery.isPending}
            searchPlaceholder="Search gateways..."
            searchLabel="Search gateways"
            emptyMessage="No gateways found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/gateways/$gatewayId',
                params: { gatewayId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
