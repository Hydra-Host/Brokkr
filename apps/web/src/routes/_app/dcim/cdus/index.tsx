import type { Cdu } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { cduColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/cdus/')({
  component: ActiveCdusPage,
});

function ActiveCdusPage() {
  const navigate = useNavigate();
  const table = useServerTable<Cdu>({ name: 'dcim-cdus-active', columns: cduColumns });

  const { data, isPending, isFetching } = tsr.listCdus.useQuery({
    queryKey: ['cdus-active', table.query],
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
      searchLabel="Search CDUs"
      emptyMessage="No active CDUs found."
      onRowClick={(cdu) => navigate({ to: '/dcim/cdus/$deviceId', params: { deviceId: cdu.deviceId } })}
    />
  );
}
