import * as p from '@clack/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { listWebhookDeliveries, retryWebhookDelivery } from '../../core/org/webhooks.js';
import { fail, formatDate, ok } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

export function registerRetryDeliveryCommand(parent: Command): void {
  parent
    .command('retry-delivery')
    .description('Retry a webhook delivery')
    .argument('[id]', 'Delivery ID to retry')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  brokkr org retry-delivery                         Interactive: pick from failed deliveries
  brokkr org retry-delivery <id>                    One-shot: retry by ID
  brokkr org retry-delivery <id> --json             One-shot with JSON output`,
    )
    .action(async (idArg: string | undefined, flags: { json: boolean }) => {
      const client = getAuthenticatedClient();
      let deliveryId = idArg;

      if (!deliveryId) {
        const deliveries = await withSpinner('Fetching deliveries...', async () => {
          const result = await listWebhookDeliveries(client, { page: 1, pageSize: 100 });
          return result.data.filter((d) => d.status === 'FAILED' || d.status === 'RETRYING');
        });

        if (deliveries.length === 0) {
          fail('No failed deliveries to retry');
        }

        p.intro(chalk.bold('Retry Webhook Delivery'));

        deliveryId = prompt(
          await p.select({
            message: 'Select delivery to retry',
            options: deliveries.map((d) => ({
              value: d.id,
              label: `${d.eventType} -> ${d.webhookEndpoint}`,
              hint: `${d.status} · ${formatDate(d.createdAt)}`,
            })),
          }),
        );
      }

      const result = await withSpinner('Retrying delivery...', async () => {
        return retryWebhookDelivery(client, deliveryId!);
      });

      if (flags.json) {
        renderJson(result);
        return;
      }

      ok(`Delivery ${chalk.bold(result.id)} retried`);
    });
}
