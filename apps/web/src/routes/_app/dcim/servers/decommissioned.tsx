import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';

import type { Server } from '@repo/api-client';
import { DeviceStatusBadge } from '@repo/ui/components/device-status-badge';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import type { FilterFieldConfig } from '@repo/ui/hooks/use-filters';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { useDcimDeviceListEvents } from '~/hooks/use-device-events';
import { tsr } from '~/lib/api';

const FILTER_FIELDS: FilterFieldConfig[] = [
  { field: 'gpuModel', label: 'GPU Model', type: 'string' },
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'nickname', label: 'Nickname', type: 'string' },
];

const columns: ServerColumnDef<Server>[] = [
  {
    id: 'name',
    header: 'Name',
    sortField: 'name',
    accessorFn: (row) => row.dcim?.nickname || row.name,
    cell: ({ row }) => {
      const device = row.original;
      const displayName = device.dcim?.nickname || device.name;
      return (
        <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
          <Link
            to="/dcim/servers/$deviceId"
            params={{ deviceId: device.id }}
            className="hover:text-primary truncate font-medium underline"
          >
            {displayName}
          </Link>
          <span className="font-mono text-xs">{device.id}</span>
        </div>
      );
    },
  },
  {
    id: 'ipv4',
    header: 'IPv4',
    sortField: 'ipv4',
    size: 140,
    cell: ({ row }) => {
      const ip = row.original.networking.ipv4;
      if (!ip) return <span className="text-muted-foreground">-</span>;
      return <span className="truncate font-mono text-xs">{ip}</span>;
    },
  },
  {
    id: 'gpu',
    header: 'GPU',
    breakpoint: 'tablet',
    cell: ({ row }) => {
      const { gpu } = row.original.specs;
      if (!gpu.model) return <span className="text-muted-foreground">-</span>;
      return (
        <span className="truncate text-sm">
          {gpu.count && gpu.count > 1 ? `${gpu.count}x ` : ''}
          {gpu.model}
        </span>
      );
    },
  },

  {
    accessorKey: 'status',
    header: 'Status',
    sortField: 'status',
    size: 130,
    cell: ({ row }) => {
      const status = row.original.status;
      if (!status?.label) return '-';
      return <DeviceStatusBadge status={status.label} />;
    },
  },
];

export const Route = createFileRoute('/_app/dcim/servers/decommissioned')({
  component: DecommissionedServers,
});

function DecommissionedServers() {
  useDcimDeviceListEvents();
  const table = useServerTable<Server>({
    name: 'dcim-servers-decommissioned',
    columns,
    filterFields: FILTER_FIELDS,
  });

  const { data, isPending, isFetching } = tsr.getServers.useQuery({
    queryKey: ['servers-decommissioned', table.query],
    queryData: { query: { ...table.query, decommissioned: true } },
    placeholderData: keepPreviousData,
  });

  const devices = data?.status === 200 ? data.body.data : [];
  const meta = data?.status === 200 ? data.body.meta : undefined;

  return (
    <ServerDataTable
      table={table}
      data={devices}
      meta={meta}
      isPending={isPending}
      isFetching={isFetching && !isPending}
      searchPlaceholder="Search decommissioned servers..."
      searchLabel="Search decommissioned servers"
      emptyMessage="No decommissioned servers found."
    />
  );
}
