import type { Switch } from '@repo/api-client';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { switchColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/switches/')({
  component: ActiveSwitchesPage,
});

function ActiveSwitchesPage() {
  const navigate = useNavigate();
  const table = useServerTable<Switch>({ name: 'dcim-switches-active', columns: switchColumns });

  const { data, isPending, isFetching } = tsr.listSwitches.useQuery({
    queryKey: ['switches-active', table.query],
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
      searchLabel="Search switches"
      emptyMessage="No active switches found."
      onRowClick={(sw) => navigate({ to: '/dcim/switches/$deviceId', params: { deviceId: sw.deviceId } })}
    />
  );
}
