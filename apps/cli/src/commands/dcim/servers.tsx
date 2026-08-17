import { Command } from 'commander';
import { Box, Text } from 'ink';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import {
  deviceComputeFields,
  deviceDeploymentFields,
  deviceDetailFields,
  deviceListColumns,
  deviceListingFields,
  deviceNetworkingFields,
  deviceStorageFields,
} from '../../core/dcim/columns.js';
import { getServer, listServers } from '../../core/dcim/servers.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { SectionFields } from '../../tui/components/section-fields.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  FILTER_GRAMMAR_HELP,
  fetchPage,
  filtersOption,
  paginationFooter,
  paginationOptions,
  renderJson,
  searchOption,
  sortOption,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

const SERVERS_HELP_FIELDS = `Filterable fields (--filters "field:op:value|..."):
  role          enum     eq, neq       Values: Baremetal, DiscoveredHost, OffMarketplaceHost, Decommissioned
  status        string   eq, neq, contains
  gpuModel      string   eq, neq, contains
  gpuCount      number   eq, neq, gt, gte, lt, lte
  memory        number   eq, neq, gt, gte, lt, lte           (GB)
  name          string   eq, neq, contains
  nickname      string   eq, neq, contains
  createdAt     date     eq, neq, gt, gte, lt, lte           (ISO 8601)

Sortable fields (--sort "field:asc|desc,..."):
  name, nickname, status, gpuCount, memory, isListed, hourlyPrice, ipv4, createdAt
  Default sort: name:asc

Searchable fields (--search matches any of):
  id, nickname, name, serial, gpuModel, cpuModel

Legacy convenience flag:
  --status <s>   Shortcut for --filters "status:eq:<s>". Value is case-sensitive.
`;

function registerServerListCommand(
  parent: Command,
  config: { name: string; role: string; description: string; helpExamples: string },
): void {
  filtersOption(
    searchOption(
      sortOption(
        paginationOptions(
          parent.command(config.name).description(config.description).argument('[id]', 'Device ID to show details for'),
        ),
      ),
    ),
  )
    .option('--status <status>', 'Shortcut for --filters "status:eq:<status>"')
    .addHelpText('after', config.helpExamples)
    .action(async (id: string | undefined, flags: PaginationFlags & { status?: string }, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showServer(id, flags.json);
      } else {
        await listServersAction(flags, config.role, `brokkr dcim ${config.name}`);
      }
    });
}

export function registerServersCommand(parent: Command): void {
  registerServerListCommand(parent, {
    name: 'servers',
    role: 'Baremetal',
    description: 'List active baremetal servers, or show one by ID',
    helpExamples: `
${SERVERS_HELP_FIELDS}
${FILTER_GRAMMAR_HELP}

Examples:
  brokkr dcim servers --json                                          List all active servers as JSON
  brokkr dcim servers --sort hourlyPrice:desc --page-size 1 --json    Most expensive server
  brokkr dcim servers --filters "gpuCount:gte:8" --json               Servers with >= 8 GPUs
  brokkr dcim servers --filters "gpuModel:contains:H100" --json       Any H100 variants
  brokkr dcim servers --filters "gpuCount:gte:4|status:eq:active"     Combine filters (AND)
  brokkr dcim servers --search "RTX" --json                           Free-text search
  brokkr dcim servers <id> --json                                     Get full server details

Price fields (pricePerHourCents) are in cents. Divide by 100 for dollars.`,
  });
}

export function registerDecommissionedServersCommand(parent: Command): void {
  registerServerListCommand(parent, {
    name: 'decommissioned-servers',
    role: 'Decommissioned',
    description: 'List decommissioned servers, or show one by ID',
    helpExamples: `
(Shares the servers pagination config; role is pinned to "Decommissioned".)

${SERVERS_HELP_FIELDS}
${FILTER_GRAMMAR_HELP}

Examples:
  brokkr dcim decommissioned-servers --json                               List all decommissioned servers as JSON
  brokkr dcim decommissioned-servers --filters "gpuModel:contains:H100"   Decommissioned H100s
  brokkr dcim decommissioned-servers --search "RTX" --json                Search decommissioned servers
  brokkr dcim decommissioned-servers <id> --json                          Get full server details`,
  });
}

async function listServersAction(
  flags: PaginationFlags & { status?: string },
  role: string,
  cmd: string,
): Promise<void> {
  const isDecommissioned = role === 'Decommissioned';
  const result = await withSpinner(
    `Fetching ${isDecommissioned ? 'decommissioned servers' : 'servers'}...`,
    async () => {
      const client = getAuthenticatedClient();
      return fetchPage(
        (query) => listServers(client, { ...query, role, ...(flags.status ? { status: flags.status } : {}) }),
        flags,
      );
    },
  );

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title={isDecommissioned ? 'Decommissioned Servers' : 'Servers'}
      columns={deviceListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, cmd)}
    />,
  );
}

async function showServer(deviceId: string, json: boolean): Promise<void> {
  const server = await withSpinner(`Fetching server ${deviceId}...`, async () => {
    const client = getAuthenticatedClient();
    return getServer(client, deviceId);
  });

  if (json) {
    renderJson(server);
    return;
  }

  renderOnce(
    <DetailContent title={server.displayName} subtitle={server.id} fields={deviceDetailFields(server)}>
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
    </DetailContent>,
  );
}
