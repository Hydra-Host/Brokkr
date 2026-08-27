import type { Pdu } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { pduColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/pdus/')({
  component: ActivePdusPage,
});

function ActivePdusPage() {
  const navigate = useNavigate();
  const table = useServerTable<Pdu>({ name: 'dcim-pdus-active', columns: pduColumns });

  const { data, isPending, isFetching } = tsr.listPdus.useQuery({
    queryKey: ['pdus-active', table.query],
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
      searchLabel="Search PDUs"
      emptyMessage="No active PDUs found."
      onRowClick={(pdu) => navigate({ to: '/dcim/pdus/$deviceId', params: { deviceId: pdu.deviceId } })}
    />
  );
}
