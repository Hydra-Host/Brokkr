import * as p from '@clack/prompts';
import type { CliApiClient } from '../../core/client.js';
import { listDeployments } from '../../core/deployments/deployments.js';
import { fail } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { withSpinner } from '../../ui/table.js';

export async function resolveDeploymentId(client: CliApiClient, idArg: string | undefined): Promise<string> {
  if (idArg) return idArg;

  const result = await withSpinner('Fetching deployments...', () =>
    listDeployments(client, { page: 1, pageSize: 100 }),
  );

  if (result.data.length === 0) {
    fail('No deployments found');
  }

  return prompt(
    await p.select({
      message: 'Select deployment',
      options: result.data.map((d) => ({
        value: d.id,
        label: d.name,
        hint: `${d.status} · ${d.location}`,
      })),
    }),
  );
}
