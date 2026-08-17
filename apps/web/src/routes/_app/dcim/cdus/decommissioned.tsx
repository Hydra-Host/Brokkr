import type { Cdu } from '@repo/api-client';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';
import { cduColumns } from './-columns';

export const Route = createFileRoute('/_app/dcim/cdus/decommissioned')({
  component: DecommissionedCdusPage,
});

function DecommissionedCdusPage() {
  const table = useServerTable<Cdu>({ name: 'dcim-cdus-decommissioned', columns: cduColumns });

  const { data, isPending, isFetching } = tsr.listCdus.useQuery({
    queryKey: ['cdus-decommissioned', table.query],
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
      searchPlaceholder="Search decommissioned CDUs..."
      searchLabel="Search decommissioned CDUs"
      emptyMessage="No decommissioned CDUs found."
    />
  );
}
