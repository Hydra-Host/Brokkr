import * as p from '@clack/prompts';
import type { CliApiClient } from '../../core/client.js';
import { listInventory } from '../../core/inventory/inventory.js';
import { fail } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { withSpinner } from '../../ui/table.js';

export async function resolveInventoryItemId(client: CliApiClient, idArg: string | undefined): Promise<string> {
  if (idArg) return idArg;

  const result = await withSpinner('Fetching available servers...', () =>
    listInventory(client, { page: 1, pageSize: 100 }),
  );

  if (result.data.length === 0) {
    fail('No available servers found in inventory');
  }

  return prompt(
    await p.select({
      message: 'Select server',
      options: result.data.map((item) => ({
        value: item.id,
        label: item.name,
        hint: `${item.stockStatus} · ${item.location ?? '—'} · ${item.pricePerHourCents != null ? `$${(item.pricePerHourCents / 100).toFixed(2)}/hr` : '—'}`,
      })),
    }),
  );
}
