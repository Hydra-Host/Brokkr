import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, Warehouse } from 'lucide-react';
import { useMemo } from 'react';

import type { ZoneListItem } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import type { FilterFieldConfig } from '@repo/ui/hooks/use-filters';

import { ServerCommissionIcon } from '~/components/server-commission-icon';
import { tsr } from '~/lib/api';

function useZoneFilterFields(): FilterFieldConfig[] {
  return useMemo(() => [{ field: 'name', label: 'Name', type: 'string' as const }], []);
}

const columns: ServerColumnDef<ZoneListItem>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    sortField: 'name',
    cell: ({ row }) => (
      <Link
        to="/dcim/zones/$zoneId"
        params={{ zoneId: String(row.original.id) }}
        preload="intent"
        className="hover:text-primary font-semibold underline"
      >
        {row.original.name || '-'}
      </Link>
    ),
  },
  {
    id: 'location',
    header: 'Location',
    cell: ({ row }) => {
      const address = row.original.primaryAddress;
      if (!address) return '-';
      const parts = [address.city, address.stateOrProvince, address.countryCode].filter(Boolean);
      return parts.join(', ') || '-';
    },
  },
  {
    id: 'timezone',
    header: 'Timezone',
    cell: ({ row }) => {
      const tz = row.original.primaryAddress?.timezone;
      if (!tz) return '-';
      return <span className="text-muted-foreground">{tz}</span>;
    },
    breakpoint: 'tablet',
  },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    sortField: 'createdAt',
    cell: ({ row }) => {
      const date = row.original.createdAt;
      if (!date) return '-';
      return new Date(date).toLocaleDateString();
    },
    breakpoint: 'desktop',
  },
  {
    id: 'actions',
    header: '',
    size: 110,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          className="group h-7 min-w-[6rem] gap-1.5 px-2 text-xs whitespace-nowrap"
          asChild
        >
          <Link to="/dcim/zones/$zoneId/commission" params={{ zoneId: String(row.original.id) }}>
            <ServerCommissionIcon className="h-4 w-4" />
            Commission
          </Link>
        </Button>
      </div>
    ),
  },
];

export const Route = createFileRoute('/_app/dcim/zones/')({
  staticData: {
    breadcrumb: 'Zones',
    description: 'All zones across your organization',
  },
  component: ZonesPage,
});

function ZonesPage() {
  const filterFields = useZoneFilterFields();
  const table = useServerTable<ZoneListItem>({ name: 'dcim-zones', columns, filterFields });

  const {
    data: response,
    isPending,
    isLoading,
    isFetching,
  } = tsr.getZones.useQuery({
    queryKey: ['zones', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const zones = response?.status === 200 ? response.body.data : [];
  const meta = response?.status === 200 ? response.body.meta : undefined;

  if (!isLoading && !isFetching && zones.length === 0 && !table.search && !table.activeFilters.length) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Warehouse className="text-muted-foreground mb-4 h-12 w-12" />
          <h3 className="mb-2 text-lg font-semibold">No zones created</h3>
          <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
            Zones help organize your infrastructure.
          </p>
          <Button asChild>
            <Link to="/dcim/zones/create">Create Zone</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-6">
        <div className="space-y-1">
          <CardTitle>Zones</CardTitle>
          <CardDescription>All zones across your organization.</CardDescription>
        </div>
        <Button className="flex items-center gap-2" asChild>
          <Link to="/dcim/zones/create">
            <Plus className="h-4 w-4" />
            Create Zone
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ServerDataTable
          table={table}
          data={zones}
          meta={meta}
          isPending={isPending}
          isFetching={isFetching && !isLoading}
          searchPlaceholder="Search zones..."
          searchLabel="Search zones"
          emptyMessage="No zones found"
        />
      </CardContent>
    </Card>
  );
}
