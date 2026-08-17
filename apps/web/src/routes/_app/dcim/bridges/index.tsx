import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Cable, Crown, MoreHorizontal } from 'lucide-react';
import { useMemo } from 'react';

import type { BridgeResponse } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import type { FilterFieldConfig } from '@repo/ui/hooks/use-filters';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { capitalizeFirstLetter, getBridgeStatusBadgeVariant, getBridgeTypeBadgeVariant } from '@repo/utils/format';
import { tsr } from '~/lib/api';

function useBridgeFilterFields(): FilterFieldConfig[] {
  return useMemo(
    () => [
      { field: 'status', label: 'Status', type: 'string' as const },
      {
        field: 'type',
        label: 'Type',
        type: 'enum' as const,
        options: ['managed', 'self-hosted'],
      },
      { field: 'zoneName', label: 'Zone', type: 'string' as const },
    ],
    [],
  );
}

export const Route = createFileRoute('/_app/dcim/bridges/')({
  staticData: {
    breadcrumb: 'Bridges',
    description: 'Manage network bridge connections between zones',
  },
  component: BridgesPage,
});

function BridgesPage() {
  const filterFields = useBridgeFilterFields();

  const bridgeColumns = useMemo(
    (): ServerColumnDef<BridgeResponse>[] => [
      {
        accessorKey: 'id',
        header: 'ID',
        cell: ({ row }) => <span className="font-mono">{row.getValue('id')}</span>,
      },
      {
        accessorKey: 'name',
        header: 'Name',
        sortField: 'name',
        cell: ({ row }) => (
          <Link
            to="/dcim/bridges/$bridgeId"
            params={{ bridgeId: String(row.original.id) }}
            preload="intent"
            className="hover:text-primary font-semibold underline"
          >
            {row.getValue('name')}
          </Link>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        sortField: 'status',
        cell: ({ row }) => {
          const status = row.original.status;
          if (!status) return '-';
          return (
            <Badge variant={getBridgeStatusBadgeVariant(status)} className="w-full justify-center">
              {capitalizeFirstLetter(status)}
            </Badge>
          );
        },
      },
      {
        id: 'online',
        header: 'Online',
        cell: ({ row }) => (
          <div className="flex items-center justify-center gap-1.5">
            <Badge variant={row.original.online ? 'success' : 'destructive'} className="justify-center">
              {row.original.online ? 'Online' : 'Offline'}
            </Badge>
            {row.original.is_leader ? (
              <Badge variant="info" className="gap-1">
                <Crown className="h-3 w-3" />
                Leader
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        sortField: 'type',
        cell: ({ row }) => {
          const type = row.original.type;
          if (!type) return '-';
          return (
            <Badge variant={getBridgeTypeBadgeVariant(type)} className="w-full justify-center">
              {capitalizeFirstLetter(type)}
            </Badge>
          );
        },
      },
      {
        id: 'interfaces',
        header: 'Interfaces',
        cell: ({ row }) => row.original.interfaces?.length ?? 0,
      },
      {
        id: 'zone',
        header: 'Zone',
        cell: ({ row }) => {
          const zone = row.original.zone;
          if (!zone?.name) return '-';
          if (zone.id) {
            return (
              <Link
                to="/dcim/zones/$zoneId"
                params={{ zoneId: zone.id }}
                preload="intent"
                className="hover:text-primary underline"
              >
                {zone.name}
              </Link>
            );
          }
          return <span>{zone.name}</span>;
        },
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/dcim/bridges/$bridgeId" params={{ bridgeId: String(row.original.id) }} className="w-full">
                  View Bridge
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  );

  const table = useServerTable<BridgeResponse>({ name: 'dcim-bridges', columns: bridgeColumns, filterFields });

  const {
    data: response,
    isPending,
    isLoading,
    isFetching,
  } = tsr.getBridges.useQuery({
    queryKey: ['bridges', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const bridges = response?.status === 200 ? response.body.data : [];
  const meta = response?.status === 200 ? response.body.meta : undefined;

  return (
    <div className="space-y-6">
      {!isLoading && !isFetching && bridges.length === 0 && !table.search && !table.activeFilters.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Cable className="text-muted-foreground mb-4 h-12 w-12" />
            <h3 className="mb-2 text-lg font-semibold">No bridges found</h3>
            <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
              Bridges are used to connect devices to the network.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-6">
            <div className="space-y-1">
              <CardTitle>Bridges</CardTitle>
              <CardDescription>Bridges are used to connect devices to the network.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ServerDataTable
              table={table}
              data={bridges}
              meta={meta}
              isPending={isPending}
              isFetching={isFetching && !isLoading}
              searchPlaceholder="Search bridges..."
              searchLabel="Search bridges"
              emptyMessage="No bridges found"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
