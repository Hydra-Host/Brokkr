import { Command } from 'commander';
import { Box, Text } from 'ink';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import {
  inventoryDetailFields,
  inventoryListColumns,
  inventoryNetworkingFields,
  inventoryPricingFields,
  inventorySpecFields,
  inventoryStorageFields,
} from '../../core/inventory/columns.js';
import { getInventoryItem, listInventory, type InventoryDetail } from '../../core/inventory/inventory.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { SectionFields } from '../../tui/components/section-fields.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  fetchPage,
  filtersOption,
  paginationFooter,
  paginationOptions,
  renderJson,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerInventoryCommand(program: Command): void {
  filtersOption(
    paginationOptions(
      program
        .command('inventory')
        .description('Browse available servers for rent, or show one by ID')
        .argument('[id]', 'Device ID to show details for'),
    ),
  )
    .addHelpText(
      'after',
      `
Browse the server marketplace. Without an ID, lists all available devices.
With an ID, shows full specs, pricing, and available operating systems.

Filterable fields (--filters "field:eq:value|..."):
  category            enum   eq only
                      Values: 3070, 3080, 3090, 4090, 5090, a10, a40, a100, a4000, a4500, a5000, a6000,
                              b200, b300, cpu, gb200, gb300, gh200, h100, h200, l40, l40s,
                              mi100, mi200, mi250, mi300, mi300x, p100, rtx6000, t4, v100, "virtual machine"
  status              enum   eq only     Values: "on demand", reserve, preorder
  interruptibleReady  bool   eq only     Values: true, false

  Inventory uses a dedicated parser that only supports the "eq" operator. Repeating the same
  field OR-combines values (e.g. "category:eq:h100|category:eq:h200"). Different fields AND together.

Default page size: 12.

Examples:
  brokkr inventory --json                                              List all available servers as JSON
  brokkr inventory --page 2 --page-size 5                              Page through listings
  brokkr inventory --filters "category:eq:h100" --json                 Only H100 listings
  brokkr inventory --filters "category:eq:h100|category:eq:h200"       H100 OR H200 (OR on same field)
  brokkr inventory --filters "status:eq:on demand" --json              Only on-demand listings
  brokkr inventory --filters "interruptibleReady:eq:true" --json       Only interruptible-ready
  brokkr inventory <id>                                                Show device specs and pricing
  brokkr inventory <id> --json                                         Full device details as JSON`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showInventoryItem(id, flags.json);
      } else {
        await listInventoryAction(flags);
      }
    });
}

async function listInventoryAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching available servers...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listInventory(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Available Servers"
      columns={inventoryListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr inventory')}
    />,
  );
}

async function showInventoryItem(id: string, json: boolean): Promise<void> {
  const item = await withSpinner(`Fetching server ${id}...`, async () => {
    const client = getAuthenticatedClient();
    return getInventoryItem(client, id);
  });

  if (json) {
    renderJson(item);
    return;
  }

  renderOnce(<InventoryDetailOutput item={item} />);
}

function InventoryDetailOutput({ item }: { item: InventoryDetail }) {
  return (
    <DetailContent title={item.name} subtitle={item.id} fields={inventoryDetailFields(item)}>
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
              Default Disk Layouts
            </Text>
          </Box>
          {item.defaultDiskLayouts.map((dl, i) => (
            <Box key={i}>
              <Text>
                {' '}
                {dl.diskType} · {dl.config} · {dl.format} · {dl.mountpoint}
              </Text>
            </Box>
          ))}
        </>
      )}
    </DetailContent>
  );
}
