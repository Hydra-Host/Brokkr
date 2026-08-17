import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { getBridge, listBridges, type BridgeListItem } from '../../core/dcim/bridges.js';
import { bridgeDetailFields, bridgeListColumns, interfaceColumns } from '../../core/dcim/columns.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { StaticTable } from '../components/static-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function BridgesListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listBridges(client, query),
  );

  if (loading) return <Loading message="Fetching bridges..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<BridgeListItem>
      columns={bridgeListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'bridge-detail', params: { id: String(row.id) }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function BridgeDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data, loading, error } = useAsync(() => getBridge(client, id), [id]);

  if (loading) return <Loading message="Loading bridge..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!data) return <ErrorView message="Bridge not found" onBack={pop} />;

  return (
    <DetailView title={data.name} subtitle={`#${data.id}`} fields={bridgeDetailFields(data)} onBack={pop}>
      <StaticTable title="Interfaces" columns={interfaceColumns} rows={data.interfaces} />
    </DetailView>
  );
}
