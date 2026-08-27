import type { Server, ServerFilterOptions } from '@repo/api-client';
import { DeviceSpecsHoverCard } from '@repo/domain-ui/components/device-specs-hover-card';
import { DeviceStatusBadge } from '@repo/domain-ui/components/device-status-badge';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { DataTableSelectColumn } from '@repo/ui/components/data-table';
import type { FilterFieldConfig, FilterFieldType } from '@repo/ui/hooks/use-filters';
import { navigatePreservingSearch } from '@repo/ui/utils';
import { formatPriceFromCentsToDollars } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Check, DollarSign, Minus, X } from 'lucide-react';
import { useMemo } from 'react';
import { CommissionServersButton } from '~/components/commission-servers-button';
import { ServerCommissionIcon } from '~/components/server-commission-icon';
import { useDcimDeviceListEvents } from '~/hooks/use-device-events';
import { tsr } from '~/lib/api';

type FilterFieldDef = {
  field: string;
  label: string;
  type: FilterFieldType;
  optionsKey: keyof ServerFilterOptions;
};

const FILTER_FIELD_DEFS: FilterFieldDef[] = [
  { field: 'gpuCount', label: 'GPU Count', type: 'number', optionsKey: 'gpuCounts' },
  { field: 'gpuModel', label: 'GPU Model', type: 'string', optionsKey: 'gpuModels' },
  { field: 'memory', label: 'Memory (GB)', type: 'number', optionsKey: 'memorySizes' },
  { field: 'status', label: 'Status', type: 'enum', optionsKey: 'statuses' },
  { field: 'isHealthy', label: 'Health', type: 'enum', optionsKey: 'healthStates' },
];

const selectColumn = { ...(DataTableSelectColumn as ServerColumnDef<Server>), size: 32 };

const columns: ServerColumnDef<Server>[] = [
  selectColumn,
  {
    id: 'name',
    header: 'Name',
    sortField: 'name',
    accessorFn: (row) => row.dcim?.nickname || row.name,
    cell: ({ row }) => {
      const device = row.original;
      const displayName = device.dcim?.nickname || device.name;
      return (
        <DeviceSpecsHoverCard specs={device.specs} title={displayName ?? 'Server'}>
          <div className="flex min-h-9 flex-col justify-center" onClick={(e) => e.stopPropagation()}>
            <Link
              to="/dcim/servers/$deviceId"
              params={{ deviceId: device.id }}
              className="hover:text-primary font-medium underline"
            >
              {displayName}
            </Link>
            <span className="font-mono text-xs">{device.id}</span>
          </div>
        </DeviceSpecsHoverCard>
      );
    },
  },
  {
    id: 'ip',
    header: 'IP',
    size: 140,
    cell: ({ row }) => {
      const { ipv4, ipv6 } = row.original.networking;
      if (!ipv4 && !ipv6) return <span className="text-muted-foreground">-</span>;
      return (
        <div className="flex flex-col">
          {ipv4 && <span className="font-mono text-xs">{ipv4}</span>}
          {ipv6 && <span className="text-muted-foreground font-mono text-xs">{ipv6}</span>}
        </div>
      );
    },
  },
  {
    id: 'gpu',
    header: 'GPU / CPU',
    breakpoint: 'tablet',
    cell: ({ row }) => {
      const { gpu, cpu } = row.original.specs;
      const model = gpu.model ?? cpu.model;
      const count = gpu.model ? gpu.count : cpu.count;
      if (!model) return <span className="text-muted-foreground">-</span>;
      return (
        <span className="text-sm">
          {count && count > 1 ? `${count}x ` : ''}
          {model}
        </span>
      );
    },
  },
  {
    id: 'listed',
    header: 'Listed',
    sortField: 'isListed',
    size: 120,
    cell: ({ row }) => {
      const { isActive, isInterruptibleOnly } = row.original.listing;
      return (
        <div className="flex flex-col items-start gap-0.5">
          <Badge variant={isActive ? 'default' : 'outline'}>{isActive ? 'Listed' : 'Unlisted'}</Badge>
          {isActive && isInterruptibleOnly && <span className="text-xs text-amber-500">Interruptible Only</span>}
        </div>
      );
    },
  },
  {
    id: 'price',
    header: 'Pricing',
    sortField: 'hourlyPrice',
    breakpoint: 'tablet',
    size: 150,
    cell: ({ row }) => {
      const { listing, specs } = row.original;
      const gpuCount = specs.gpu.count;
      const usePerGpu = !!(gpuCount && listing.onDemandPrice.perHour.perGpu);
      const unit = usePerGpu ? 'GPU/Hr' : '/Hr';

      const onDemand = usePerGpu ? listing.onDemandPrice.perHour.perGpu : listing.onDemandPrice.perHour.total;
      const floor = usePerGpu ? listing.interruptiblePrice.perHour.perGpu : listing.interruptiblePrice.perHour.total;

      if (!onDemand) return <span className="text-muted-foreground">-</span>;

      return (
        <div className="flex flex-col py-1">
          <span className="text-sm whitespace-nowrap text-emerald-500">
            {formatPriceFromCentsToDollars(onDemand)} {unit}
          </span>
          {floor ? (
            <span className="text-muted-foreground mt-0.5 text-xs whitespace-nowrap">
              {formatPriceFromCentsToDollars(floor)} {unit} - Floor
            </span>
          ) : null}
        </div>
      );
    },
  },
  {
    id: 'healthy',
    header: 'Healthy',
    size: 70,
    cell: ({ row }) => {
      const { isHealthy } = row.original;
      if (isHealthy === null || isHealthy === undefined) return <Minus className="text-muted-foreground h-4 w-4" />;
      return isHealthy ? <Check className="h-4 w-4 text-emerald-500" /> : <X className="h-4 w-4 text-red-500" />;
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

export const Route = createFileRoute('/_app/dcim/servers/_active')({
  component: ActiveServersLayout,
});

function ActiveServersLayout() {
  useDcimDeviceListEvents();
  const navigate = useNavigate();

  const filterOptionsQuery = tsr.getServerFilterOptions.useQuery({
    queryKey: ['servers-active', 'filter-options'],
  });
  const filterOptions = filterOptionsQuery.data?.status === 200 ? filterOptionsQuery.data.body : null;

  const filterFields = useMemo<FilterFieldConfig[]>(() => {
    return FILTER_FIELD_DEFS.map(({ optionsKey, ...field }) => {
      if (!filterOptions) {
        return field;
      }
      return {
        ...field,
        options: (filterOptions[optionsKey] as Array<string | number>).map(String),
      };
    });
  }, [filterOptions]);

  const table = useServerTable<Server>({
    name: 'dcim-servers-active',
    columns,
    filterFields,
  });

  const { data, isPending, isFetching } = tsr.getServers.useQuery({
    queryKey: ['servers-active', table.query],
    queryData: { query: { ...table.query } },
    placeholderData: keepPreviousData,
  });

  const devices = useMemo(() => (data?.status === 200 ? data.body.data : []), [data]);
  const meta = data?.status === 200 ? data.body.meta : undefined;

  const onRowClick = (device: Server) => {
    navigatePreservingSearch(navigate, {
      to: '/dcim/servers/server-details',
      search: (prev) => ({ ...prev, deviceId: device.id }),
    });
  };

  const isBlankSlate =
    !isPending && !isFetching && devices.length === 0 && !table.search && !table.activeFilters.length;

  if (isBlankSlate) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-12">
          <ServerCommissionIcon className="text-muted-foreground mb-4 h-12 w-12" />
          <h3 className="mb-2 text-lg font-semibold">No servers yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
            Commission your first server to start managing your fleet.
          </p>
          <CommissionServersButton />
        </div>
        <Outlet />
      </>
    );
  }

  return (
    <>
      <ServerDataTable
        table={table}
        data={devices}
        meta={meta}
        isPending={isPending}
        isFetching={isFetching && !isPending}
        searchPlaceholder="Search by name, ID, IP, GPU, or zone..."
        searchLabel="Search servers"
        emptyMessage="No active servers found."
        onRowClick={onRowClick}
        renderTableActions={(t) => {
          const selected = t.getFilteredSelectedRowModel().rows.map((row) => row.original);
          return (
            <Button
              size="sm"
              onClick={() => {
                if (selected.length === 0) return;
                navigatePreservingSearch(navigate, {
                  to: '/dcim/servers/update-monetization',
                  search: (prev) => ({
                    ...prev,
                    deviceIds: selected.map((d) => d.id),
                  }),
                });
              }}
            >
              <DollarSign className="mr-1 h-4 w-4" />
              Update Monetization
            </Button>
          );
        }}
      />
      <Outlet />
    </>
  );
}
