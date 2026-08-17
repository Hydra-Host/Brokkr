import type { Switch } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { Link } from '@tanstack/react-router';

const dash = <span className="text-muted-foreground">--</span>;

export const switchColumns: ServerColumnDef<Switch>[] = [
  {
    id: 'name',
    header: 'Name',
    sortField: 'name',
    accessorFn: (row) => row.nickname || row.name,
    cell: ({ row }) => {
      const sw = row.original;
      return (
        <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
          <Link
            to="/dcim/switches/$deviceId"
            params={{ deviceId: sw.deviceId }}
            className="hover:text-primary font-medium underline"
          >
            {sw.nickname || sw.name}
          </Link>
          <span className="font-mono text-xs">{sw.deviceId}</span>
        </div>
      );
    },
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    sortField: 'status',
    size: 120,
    cell: ({ row }) => <span className="text-sm">{row.original.status}</span>,
  },
  {
    id: 'powerStatus',
    header: 'Power',
    size: 90,
    cell: ({ row }) => {
      const power = row.original.powerStatus;
      if (!power) return dash;
      return <Badge variant={power === 'On' ? 'default' : 'outline'}>{power}</Badge>;
    },
  },
  {
    id: 'switchRole',
    header: 'Role',
    size: 130,
    cell: ({ row }) => <span className="text-sm">{row.original.switchRole ?? dash}</span>,
  },
  {
    id: 'fabric',
    header: 'Fabric',
    size: 120,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.fabric ?? dash}</span>,
  },
  {
    id: 'portCount',
    header: 'Ports',
    size: 90,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.portCount ?? dash}</span>,
  },
  {
    id: 'zoneName',
    header: 'Data Center',
    breakpoint: 'desktop',
    cell: ({ row }) => <span className="text-sm">{row.original.zoneName ?? dash}</span>,
  },
];
