import type { Router } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { routerColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/routers/')({
  component: ActiveRoutersPage,
});

function ActiveRoutersPage() {
  const navigate = useNavigate();
  const table = useServerTable<Router>({ name: 'dcim-routers-active', columns: routerColumns });

  const { data, isPending, isFetching } = tsr.listRouters.useQuery({
    queryKey: ['routers-active', table.query],
    queryData: { query: { ...table.query } },
    placeholderData: keepPreviousData,
  });

  const rows = data?.status === 200 ? data.body.data : [];
  const meta = data?.status === 200 ? data.body.meta : undefined;

  return (
    <ServerDataTable
      table={table}
      data={rows}
      meta={meta}
      isPending={isPending}
      isFetching={isFetching && !isPending}
      searchPlaceholder="Search by name or nickname..."
      searchLabel="Search routers"
      emptyMessage="No active routers found."
      onRowClick={(rtr) => navigate({ to: '/dcim/routers/$deviceId', params: { deviceId: rtr.deviceId } })}
    />
  );
}
