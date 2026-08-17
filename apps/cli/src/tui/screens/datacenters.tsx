import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import {
  bridgeColumns,
  contactColumns,
  datacenterDetailFields,
  datacenterListColumns,
} from '../../core/dcim/columns.js';
import {
  getDatacenter,
  getDatacenterContacts,
  listDatacenters,
  type DatacenterListItem,
} from '../../core/dcim/datacenters.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { StaticTable } from '../components/static-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function DatacentersListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listDatacenters(client, query),
  );

  if (loading) return <Loading message="Fetching data centers..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<DatacenterListItem>
      columns={datacenterListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'datacenter-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function DatacenterDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data, loading, error } = useAsync(
    () =>
      Promise.all([getDatacenter(client, id), getDatacenterContacts(client, id)]).then(([dc, contacts]) => ({
        dc,
        contacts,
      })),
    [id],
  );

  if (loading) return <Loading message="Loading data center..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!data) return <ErrorView message="Data center not found" onBack={pop} />;

  const { dc, contacts } = data;

  return (
    <DetailView title={dc.name} subtitle={dc.id} fields={datacenterDetailFields(dc)} onBack={pop}>
      <StaticTable title="Contacts" columns={contactColumns} rows={contacts} />
      <StaticTable title="Bridges" columns={bridgeColumns} rows={dc.bridges} />
    </DetailView>
  );
}
