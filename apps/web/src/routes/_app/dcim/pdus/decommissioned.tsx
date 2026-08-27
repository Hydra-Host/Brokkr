import type { Pdu } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { pduColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/pdus/decommissioned')({
  component: DecommissionedPdusPage,
});

function DecommissionedPdusPage() {
  const table = useServerTable<Pdu>({ name: 'dcim-pdus-decommissioned', columns: pduColumns });

  const { data, isPending, isFetching } = tsr.listPdus.useQuery({
    queryKey: ['pdus-decommissioned', table.query],
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
      searchPlaceholder="Search decommissioned PDUs..."
      searchLabel="Search decommissioned PDUs"
      emptyMessage="No decommissioned PDUs found."
    />
  );
}
