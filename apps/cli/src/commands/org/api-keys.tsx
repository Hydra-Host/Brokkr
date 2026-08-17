import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import { getApiKey, listApiKeys } from '../../core/org/api-keys.js';
import { apiKeyDetailFields, apiKeyListColumns } from '../../core/org/columns.js';
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

export function registerApiKeysCommand(parent: Command): void {
  searchOption(
    sortOption(
      paginationOptions(
        parent
          .command('api-keys')
          .description('List API keys, or show one by ID')
          .argument('[id]', 'API key ID to show details for'),
      ),
    ),
  )
    .option('--created-by <email>', 'Legacy filter by creator email (exact match)')
    .addHelpText(
      'after',
      `
Sortable fields (--sort "field:asc|desc,..."):
  name, createdAt, expiresAt
  Default sort: createdAt:desc

Searchable fields (--search matches any of):
  name, user.email, user.name

Legacy filter flag:
  --created-by <email>   Exact-match filter against the creator's email.

Examples:
  brokkr org api-keys --json                                List all API keys as JSON
  brokkr org api-keys --created-by "user@example.com"       Legacy filter by creator email
  brokkr org api-keys --sort expiresAt:asc --json           Soonest to expire first
  brokkr org api-keys --search "ci-" --json                 Search key names or creators
  brokkr org api-keys <id> --json                           Get API key details`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags & { createdBy?: string }, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showApiKey(id, flags.json);
      } else {
        await listApiKeysAction(flags);
      }
    });
}

async function listApiKeysAction(flags: PaginationFlags & { createdBy?: string }): Promise<void> {
  const result = await withSpinner('Fetching API keys...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage(
      (query) => listApiKeys(client, { ...query, ...(flags.createdBy ? { createdByEmail: flags.createdBy } : {}) }),
      flags,
    );
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="API Keys"
      columns={apiKeyListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr org api-keys')}
    />,
  );
}

async function showApiKey(apiKeyId: string, json: boolean): Promise<void> {
  const key = await withSpinner(`Fetching API key ${apiKeyId}...`, async () => {
    const client = getAuthenticatedClient();
    return getApiKey(client, apiKeyId);
  });

  if (json) {
    renderJson(key);
    return;
  }

  renderOnce(<DetailContent title={key.name ?? 'API Key'} subtitle={key.id} fields={apiKeyDetailFields(key)} />);
}
