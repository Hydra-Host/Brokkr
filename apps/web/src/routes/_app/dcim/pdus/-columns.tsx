import type { Pdu } from '@repo/api-client';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Link } from '@tanstack/react-router';

const dash = <span className="text-muted-foreground">--</span>;

export const pduColumns: ServerColumnDef<Pdu>[] = [
  {
    id: 'name',
    header: 'Name',
    sortField: 'name',
    accessorFn: (row) => row.nickname || row.name,
    cell: ({ row }) => {
      const pdu = row.original;
      return (
        <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
          <Link
            to="/dcim/pdus/$deviceId"
            params={{ deviceId: pdu.deviceId }}
            className="hover:text-primary font-medium underline"
          >
            {pdu.nickname || pdu.name}
          </Link>
          <span className="font-mono text-xs">{pdu.deviceId}</span>
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
    id: 'outletCount',
    header: 'Outlets',
    size: 90,
    cell: ({ row }) => <span className="text-sm">{row.original.outletCount ?? dash}</span>,
  },
  {
    id: 'ratedAmperage',
    header: 'Amps',
    size: 90,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.ratedAmperage ?? dash}</span>,
  },
  {
    id: 'voltageType',
    header: 'Voltage',
    size: 100,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.voltageType ?? dash}</span>,
  },
  {
    id: 'zoneName',
    header: 'Data Center',
    breakpoint: 'desktop',
    cell: ({ row }) => <span className="text-sm">{row.original.zoneName ?? dash}</span>,
  },
];
