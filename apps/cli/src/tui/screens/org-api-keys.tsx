import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import { getApiKey, listApiKeys, type ApiKeyListItem } from '../../core/org/api-keys.js';
import { apiKeyDetailFields, apiKeyListColumns } from '../../core/org/columns.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function ApiKeysListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listApiKeys(client, query),
  );

  if (loading) return <Loading message="Fetching API keys..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<ApiKeyListItem>
      columns={apiKeyListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'org-api-key-detail', params: { id: row.id }, title: row.name ?? 'API Key' })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function ApiKeyDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: key, loading, error } = useAsync(() => getApiKey(client, id), [id]);

  if (loading) return <Loading message="Loading API key..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!key) return <ErrorView message="API key not found" onBack={pop} />;

  return <DetailView title={key.name ?? 'API Key'} subtitle={key.id} fields={apiKeyDetailFields(key)} onBack={pop} />;
}
