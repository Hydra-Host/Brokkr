import { Box, Text } from 'ink';
import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import {
  deviceComputeFields,
  deviceDeploymentFields,
  deviceDetailFields,
  deviceListColumns,
  deviceListingFields,
  deviceNetworkingFields,
  deviceStorageFields,
} from '../../core/dcim/columns.js';
import { getServer, listServers, type ServerListItem } from '../../core/dcim/servers.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { SectionFields } from '../components/section-fields.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function ServersListScreen({ client, role }: { client: CliApiClient; role?: string }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listServers(client, { ...query, ...(role ? { role } : {}) }),
  );

  if (loading) return <Loading message="Fetching servers..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<ServerListItem>
      columns={deviceListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'server-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function ServerDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: server, loading, error } = useAsync(() => getServer(client, id), [id]);

  if (loading) return <Loading message="Loading server..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!server) return <ErrorView message="Server not found" onBack={pop} />;

  return (
    <DetailView title={server.displayName} subtitle={server.id} fields={deviceDetailFields(server)} onBack={pop}>
      <SectionFields title="Compute" fields={deviceComputeFields(server)} />
      <SectionFields title="Storage" fields={deviceStorageFields(server)} />
      <SectionFields title="Networking" fields={deviceNetworkingFields(server)} />
      <SectionFields title="Listing" fields={deviceListingFields(server)} />
      <SectionFields title="Deployment" fields={deviceDeploymentFields(server)} />
      {server.availableBaseLayers.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              Available Base Layers
            </Text>
          </Box>
          {server.availableBaseLayers.map((l, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {l.name} ({l.slug})
              </Text>
            </Box>
          ))}
        </>
      )}
    </DetailView>
  );
}
