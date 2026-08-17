import type { IpAddress } from '@repo/api-client';

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
    case 'DHCP':
      return 'outline';
    default:
      return 'outline';
  }
}

const columns: ServerColumnDef<IpAddress>[] = [
  {
    id: 'address',
    accessorKey: 'address',
    header: 'Address',
    sortField: 'address',
    size: 200,
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.address}</span>,
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 120,
    cell: ({ row }) => <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>,
  },
  {
    id: 'dnsName',
    accessorKey: 'dnsName',
    header: 'DNS Name',
    cell: ({ row }) => (
      <span className="text-sm">{row.original.dnsName || <span className="text-muted-foreground">--</span>}</span>
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

export const Route = createFileRoute('/_app/ipam/ip-addresses/')({
  staticData: { breadcrumb: 'IP Addresses' },
  component: IpAddressesPage,
});

function IpAddressesPage() {
  useDocumentTitle('IP Addresses');
  const navigate = useNavigate();
  const table = useServerTable<IpAddress>({ name: 'ip-addresses', columns });

  const ipAddressesQuery = tsr.listIpAddresses.useQuery({
    queryKey: ['ip-addresses'],
    queryData: { query: {} },
  });

  const rows = ipAddressesQuery.data?.status === 200 ? ipAddressesQuery.data.body : [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>IP Addresses</CardTitle>
              <CardDescription>Manage IP addresses.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/ipam/ip-addresses/create">Create IP Address</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            isPending={ipAddressesQuery.isPending}
            searchPlaceholder="Search IP addresses..."
            searchLabel="Search IP addresses"
            emptyMessage="No IP addresses found"
            onRowClick={(row) => {
              void navigate({
                to: '/ipam/ip-addresses/$ipAddressId',
                params: { ipAddressId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
