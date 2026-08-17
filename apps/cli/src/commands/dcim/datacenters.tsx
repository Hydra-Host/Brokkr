import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import {
  bridgeColumns,
  contactColumns,
  datacenterDetailFields,
  datacenterListColumns,
} from '../../core/dcim/columns.js';
import { getDatacenter, getDatacenterContacts, listDatacenters } from '../../core/dcim/datacenters.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  fetchPage,
  paginationFooter,
  paginationOptions,
  renderJson,
  searchOption,
  sortOption,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerDatacentersCommand(parent: Command): void {
  searchOption(
    sortOption(
      paginationOptions(
        parent
          .command('datacenters')
          .alias('dc')
          .description('List data centers, or show one by ID')
          .argument('[id]', 'Data center ID to show details for'),
      ),
    ),
  )
    .addHelpText(
      'after',
      `
Data centers are called "zones" in the API — the same entity is surfaced here as "data centers".

Sortable fields (--sort "field:asc|desc,..."):
  name, createdAt
  Default sort: name:asc

Searchable fields (--search matches any of):
  name

Examples:
  brokkr dcim dc --json                         List all data centers as JSON
  brokkr dcim dc --sort name:asc --json         Sort by name
  brokkr dcim dc --sort createdAt:desc --json   Newest first
  brokkr dcim dc --search "Arizona" --json      Search by name
  brokkr dcim dc <id> --json                    Get full data center details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showDatacenter(id, flags.json);
      } else {
        await listDatacentersAction(flags);
      }
    });
}

async function listDatacentersAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching data centers...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listDatacenters(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Data Centers"
      columns={datacenterListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr dcim dc')}
    />,
  );
}

async function showDatacenter(id: string, json: boolean): Promise<void> {
  const { dc, contacts } = await withSpinner('Fetching data center...', async () => {
    const client = getAuthenticatedClient();
    const [dcResult, contactsResult] = await Promise.all([
      getDatacenter(client, id),
      getDatacenterContacts(client, id),
    ]);
    return { dc: dcResult, contacts: contactsResult };
  });

  if (json) {
    renderJson({ ...dc, contacts });
    return;
  }

  renderOnce(
    <DetailContent title={dc.name} subtitle={dc.id} fields={datacenterDetailFields(dc)}>
      <StaticTable title="Contacts" columns={contactColumns} rows={contacts} />
      <StaticTable title="Bridges" columns={bridgeColumns} rows={dc.bridges} />
    </DetailContent>,
  );
}
