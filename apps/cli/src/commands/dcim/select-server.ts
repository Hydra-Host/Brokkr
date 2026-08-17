import * as p from '@clack/prompts';
import type { CliApiClient } from '../../core/client.js';
import { listServers } from '../../core/dcim/servers.js';
import { fail } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { withSpinner } from '../../ui/table.js';

export async function resolveServerId(client: CliApiClient, idArg: string | undefined): Promise<string> {
  if (idArg) return idArg;

  const result = await withSpinner('Fetching servers...', () =>
    listServers(client, { page: 1, pageSize: 100, role: 'Baremetal' }),
  );

  if (result.data.length === 0) {
    fail('No servers found');
  }

  return prompt(
    await p.select({
      message: 'Select server',
      options: result.data.map((d) => ({
        value: d.id,
        label: d.name,
        hint: `${d.status} · ${d.datacenter}`,
      })),
    }),
  );
}
