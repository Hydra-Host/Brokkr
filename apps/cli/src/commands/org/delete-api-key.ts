import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { deleteApiKey, listApiKeys } from '../../core/org/api-keys.js';
import { fail, ok } from '../../ui/format.js';
import { confirmOrExit, prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerDeleteApiKeyCommand(parent: Command): void {
  parent
    .command('delete-api-key')
    .description('Delete an API key')
    .argument('[id]', 'API key ID to delete')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Deleting an API key is irreversible and breaks any integrations that still use it.

Examples:
  brokkr org delete-api-key                         Interactive: pick from keys
  brokkr org delete-api-key <id>                    Prompts for confirmation
  brokkr org delete-api-key <id> --force            Skip confirmation
  brokkr org delete-api-key <id> --force --json     Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      const client = getAuthenticatedClient();
      let apiKeyId = idArg;
      let keyName: string | null = null;

      if (!apiKeyId) {
        const keys = await withSpinner('Fetching API keys...', async () => {
          const result = await listApiKeys(client, { page: 1, pageSize: 100 });
          return result.data;
        });

        if (keys.length === 0) {
          fail('No API keys found');
        }

        p.intro(chalk.bold('Delete API Key'));

        apiKeyId = prompt(
          await p.select({
            message: 'Select API key to delete',
            options: keys.map((k) => ({
              value: k.id,
              label: k.name ?? '(unnamed)',
              hint: `${k.start ?? ''}... · ${k.enabled ? 'enabled' : 'disabled'}`,
            })),
          }),
        );

        keyName = keys.find((k) => k.id === apiKeyId)?.name ?? null;
      }

      if (!flags.force) {
        const label = keyName ? `"${keyName}"` : apiKeyId;
        await confirmOrExit(`Delete API key ${label}? This cannot be undone.`);
      }

      const result = await withSpinner('Deleting API key...', async () => {
        return deleteApiKey(client, apiKeyId!);
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`API key ${keyName ? chalk.bold(keyName) + ' ' : ''}deleted`);
    });
}
