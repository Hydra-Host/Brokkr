import type { Router } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { routerColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/routers/decommissioned')({
  component: DecommissionedRoutersPage,
});

function DecommissionedRoutersPage() {
  const table = useServerTable<Router>({ name: 'dcim-routers-decommissioned', columns: routerColumns });

  const { data, isPending, isFetching } = tsr.listRouters.useQuery({
    queryKey: ['routers-decommissioned', table.query],
    queryData: { query: { ...table.query, decommissioned: true } },
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
      searchPlaceholder="Search decommissioned routers..."
      searchLabel="Search decommissioned routers"
      emptyMessage="No decommissioned routers found."
    />
  );
}
