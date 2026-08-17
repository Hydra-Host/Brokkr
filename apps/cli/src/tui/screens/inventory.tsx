import { Box, Text } from 'ink';
import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import {
  inventoryDetailFields,
  inventoryListColumns,
  inventoryNetworkingFields,
  inventoryPricingFields,
  inventorySpecFields,
  inventoryStorageFields,
} from '../../core/inventory/columns.js';
import { getInventoryItem, listInventory, type InventoryListItem } from '../../core/inventory/inventory.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { SectionFields } from '../components/section-fields.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function InventoryListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listInventory(client, query),
  );

  if (loading) return <Loading message="Fetching available servers..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<InventoryListItem>
      columns={inventoryListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'inventory-detail', params: { id: row.id }, title: row.name })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function InventoryDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: item, loading, error } = useAsync(() => getInventoryItem(client, id), [id]);

  if (loading) return <Loading message="Loading server details..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!item) return <ErrorView message="Server not found" onBack={pop} />;

  return (
    <DetailView title={item.name} subtitle={item.id} fields={inventoryDetailFields(item)} onBack={pop}>
      <SectionFields title="Pricing" fields={inventoryPricingFields(item)} />
      <SectionFields title="Compute" fields={inventorySpecFields(item)} />
      <SectionFields title="Storage" fields={inventoryStorageFields(item)} />
      <SectionFields title="Networking" fields={inventoryNetworkingFields(item)} />
      {item.availableBaseLayers.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              Available Base Layers
            </Text>
          </Box>
          {item.availableBaseLayers.map((l, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {l.name} ({l.slug})
              </Text>
            </Box>
          ))}
        </>
      )}
      {item.defaultDiskLayouts.length > 0 && (
        <>
          <Box marginTop={1} marginBottom={0}>
            <Text bold color="cyan">
              Default Disk Layout
            </Text>
          </Box>
          {item.defaultDiskLayouts.map((dl, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {dl.diskType} · {dl.config} · {dl.format} → {dl.mountpoint}
              </Text>
            </Box>
          ))}
        </>
      )}
    </DetailView>
  );
}
