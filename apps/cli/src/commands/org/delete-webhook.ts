import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { deleteWebhook, listWebhooks } from '../../core/org/webhooks.js';
import { fail, ok } from '../../ui/format.js';
import { confirmOrExit, prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerDeleteWebhookCommand(parent: Command): void {
  parent
    .command('delete-webhook')
    .description('Delete a webhook')
    .argument('[id]', 'Webhook ID to delete')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Deleting a webhook stops delivery of events to its endpoint and is irreversible.

Examples:
  brokkr org delete-webhook                         Interactive: pick from webhooks
  brokkr org delete-webhook <id>                    Prompts for confirmation
  brokkr org delete-webhook <id> --force            Skip confirmation
  brokkr org delete-webhook <id> --force --json     Scripted mode`,
    )
    .action(async (idArg: string | undefined, flags: { force: boolean; json: boolean }) => {
      const client = getAuthenticatedClient();
      let webhookId = idArg;
      let endpoint: string | null = null;

      if (!webhookId) {
        const webhooks = await withSpinner('Fetching webhooks...', async () => {
          const result = await listWebhooks(client, { page: 1, pageSize: 100 });
          return result.data;
        });

        if (webhooks.length === 0) {
          fail('No webhooks found');
        }

        p.intro(chalk.bold('Delete Webhook'));

        webhookId = prompt(
          await p.select({
            message: 'Select webhook to delete',
            options: webhooks.map((wh) => ({
              value: wh.id,
              label: wh.endpoint,
              hint: `${wh.events.length} events · ${wh.isActive ? 'active' : 'inactive'}`,
            })),
          }),
        );

        endpoint = webhooks.find((wh) => wh.id === webhookId)?.endpoint ?? null;
      }

      if (!flags.force) {
        const label = endpoint ? `"${endpoint}"` : webhookId;
        await confirmOrExit(`Delete webhook ${label}? This cannot be undone.`);
      }

      await withSpinner('Deleting webhook...', async () => {
        return deleteWebhook(client, webhookId!);
      });

      if (flags.json) {
        renderJson({ success: true });
        return;
      }

      ok('Webhook deleted');
    });
}
