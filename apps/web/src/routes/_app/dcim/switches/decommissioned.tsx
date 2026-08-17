import type { Switch } from '@repo/api-client';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { switchColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/switches/decommissioned')({
  component: DecommissionedSwitchesPage,
});

function DecommissionedSwitchesPage() {
  const table = useServerTable<Switch>({ name: 'dcim-switches-decommissioned', columns: switchColumns });

  const { data, isPending, isFetching } = tsr.listSwitches.useQuery({
    queryKey: ['switches-decommissioned', table.query],
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
      searchPlaceholder="Search decommissioned switches..."
      searchLabel="Search decommissioned switches"
      emptyMessage="No decommissioned switches found."
    />
  );
}
