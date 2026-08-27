import type { DcimRack } from '@repo/api-client';

import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Combobox } from '@repo/ui/components/combobox';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';

import { keepPreviousData } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { ZoneChip } from '~/components/device-badges';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/racks/')({
  component: RacksPage,
});

function RacksPage() {
  useDocumentTitle('Racks');
  const navigate = useNavigate();

  const [zoneId, setZoneId] = useState<string | undefined>();

  const zonesQuery = tsr.getZones.useQuery({
    queryKey: ['zones', 'rack-filter'],
    queryData: { query: { pageSize: 1000 } },
  });
  const zones = zonesQuery.data?.status === 200 ? zonesQuery.data.body.data : [];
  const zoneNameById = useMemo(() => new Map(zones.map((z) => [z.id, z.name] as const)), [zones]);

  const columns = useMemo<ServerColumnDef<DcimRack>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Name',
        sortField: 'name',
        size: 220,
        cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: 'Status',
        sortField: 'status',
        size: 120,
        cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
      },
      {
        id: 'zone',
        header: 'Zone',
        size: 180,
        cell: ({ row }) => {
          const name = zoneNameById.get(row.original.zoneId);
          return name ? (
            <ZoneChip id={row.original.zoneId} name={name} />
          ) : (
            <span className="text-muted-foreground">--</span>
          );
        },
      },
      {
        id: 'heightU',
        accessorKey: 'heightU',
        header: 'Height (U)',
        sortField: 'heightU',
        size: 100,
        cell: ({ row }) => <span className="text-sm">{row.original.heightU}</span>,
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
    ],
    [zoneNameById],
  );

  const table = useServerTable<DcimRack>({ name: 'racks', columns });

  const query = tsr.listDcimRacks.useQuery({
    queryKey: ['dcim-racks', table.query, zoneId],
    queryData: { query: { ...table.query, ...(zoneId ? { zoneId } : {}) } },
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.status === 200 ? query.data.body.data : [];
  const meta = query.data?.status === 200 ? query.data.body.meta : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Racks</CardTitle>
              <CardDescription>Manage racks across your zones.</CardDescription>
            </div>
            <Button asChild>
              <Link to="/dcim/racks/create">Create Rack</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ServerDataTable
            table={table}
            data={rows}
            meta={meta}
            isPending={query.isPending}
            isFetching={query.isFetching}
            searchPlaceholder="Search racks..."
            searchLabel="Search racks"
            searchableFields={['Name', 'Description', 'Asset tag']}
            emptyMessage="No racks found"
            toolbar={
              <Combobox
                options={[{ value: 'all', label: 'All zones' }, ...zones.map((z) => ({ value: z.id, label: z.name }))]}
                value={zoneId ?? 'all'}
                setValue={(v) => {
                  setZoneId(!v || v === 'all' ? undefined : v);
                  table.setPage(1);
                }}
                placeholder="Filter by zone…"
                triggerClassName="w-[220px]"
                hideIcon
                emptyMessage="No zones found"
              />
            }
            onRowClick={(row) => {
              void navigate({
                to: '/dcim/racks/$rackId',
                params: { rackId: row.id },
              });
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
