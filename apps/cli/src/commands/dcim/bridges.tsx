import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { getBridge, listBridges } from '../../core/dcim/bridges.js';
import { bridgeDetailFields, bridgeListColumns, interfaceColumns } from '../../core/dcim/columns.js';
import { DetailContent } from '../../tui/components/detail-view.js';
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

export function registerBridgesCommand(parent: Command): void {
  filtersOption(
    searchOption(
      sortOption(
        paginationOptions(
          parent.command('bridges [id]').description('List bridges, or show details for a specific bridge'),
        ),
      ),
    ),
  )
    .addHelpText(
      'after',
      `
Filterable fields (--filters "field:op:value|..."):
  status          string   eq, neq, contains
  type            enum     eq, neq                 Values: managed, self-hosted
  datacenterName  string   eq, neq, contains
  zoneName        string   eq, neq, contains

Sortable fields (--sort "field:asc|desc,..."):
  name, status, type, datacenterName, zoneName
  Default sort: name:asc

Searchable fields (--search matches any of):
  name, status, type, datacenter.name, zone.name

${FILTER_GRAMMAR_HELP}

Examples:
  brokkr dcim bridges --json                                          List all bridges as JSON
  brokkr dcim bridges --sort name:asc --json                          Sort by name
  brokkr dcim bridges --filters "type:eq:managed" --json              Managed bridges only
  brokkr dcim bridges --filters "datacenterName:contains:arizona"     Arizona DCs
  brokkr dcim bridges --search "prod" --json                          Free-text search
  brokkr dcim bridges <id> --json                                     Get full bridge details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showBridge(id, flags.json);
      } else {
        await listBridgesAction(flags);
      }
    });
}

async function listBridgesAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching bridges...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((q) => listBridges(client, q), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Bridges"
      columns={bridgeListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr dcim bridges')}
    />,
  );
}

async function showBridge(id: string, json: boolean): Promise<void> {
  const bridge = await withSpinner(`Fetching bridge ${id}...`, async () => {
    const client = getAuthenticatedClient();
    return getBridge(client, id);
  });

  if (json) {
    renderJson(bridge);
    return;
  }

  renderOnce(
    <DetailContent title={bridge.name} subtitle={`#${bridge.id}`} fields={bridgeDetailFields(bridge)}>
      <StaticTable title="Interfaces" columns={interfaceColumns} rows={bridge.interfaces} />
    </DetailContent>,
  );
}
