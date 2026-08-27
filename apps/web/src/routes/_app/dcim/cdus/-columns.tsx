import type { Cdu } from '@repo/api-client';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Link } from '@tanstack/react-router';

const dash = <span className="text-muted-foreground">--</span>;

export const cduColumns: ServerColumnDef<Cdu>[] = [
  {
    id: 'name',
    header: 'Name',
    sortField: 'name',
    accessorFn: (row) => row.nickname || row.name,
    cell: ({ row }) => {
      const cdu = row.original;
      return (
        <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
          <Link
            to="/dcim/cdus/$deviceId"
            params={{ deviceId: cdu.deviceId }}
            className="hover:text-primary font-medium underline"
          >
            {cdu.nickname || cdu.name}
          </Link>
          <span className="font-mono text-xs">{cdu.deviceId}</span>
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
    id: 'coolantType',
    header: 'Coolant',
    size: 100,
    cell: ({ row }) => <span className="text-sm">{row.original.coolantType ?? dash}</span>,
  },
  {
    id: 'ratedFlowRateLpm',
    header: 'Flow (L/min)',
    size: 110,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.ratedFlowRateLpm ?? dash}</span>,
  },
  {
    id: 'ratedThermalCapacityKw',
    header: 'Capacity (kW)',
    size: 120,
    breakpoint: 'tablet',
    cell: ({ row }) => <span className="text-sm">{row.original.ratedThermalCapacityKw ?? dash}</span>,
  },
  {
    id: 'airflow',
    header: 'Airflow',
    size: 110,
    breakpoint: 'desktop',
    cell: ({ row }) => <span className="text-sm">{row.original.airflow}</span>,
  },
  {
    id: 'zoneName',
    header: 'Data Center',
    breakpoint: 'desktop',
    cell: ({ row }) => <span className="text-sm">{row.original.zoneName ?? dash}</span>,
  },
];
