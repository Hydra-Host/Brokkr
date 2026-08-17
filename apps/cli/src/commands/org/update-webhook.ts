import * as p from '@clack/prompts';
import { WebhookEventTypeSchema } from '@repo/api-client';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { getWebhook, listWebhooks, parseWebhookEvents, updateWebhook } from '../../core/org/webhooks.js';
import { fail, ok, parseToggle, validateHttpsUrl } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

const VALID_EVENTS = WebhookEventTypeSchema.options;

export function registerUpdateWebhookCommand(parent: Command): void {
  parent
    .command('update-webhook')
    .description('Update a webhook')
    .argument('[id]', 'Webhook ID')
    .option('--endpoint <url>', 'New endpoint URL (https)')
    .option('--description <desc>', 'New description')
    .option('--events <events>', 'Comma-separated event types')
    .option('--active <on|off>', 'Enable or disable')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
In one-shot mode, only provided flags are changed. Current values are kept for omitted flags.

Examples:
  brokkr org update-webhook                                              Interactive mode
  brokkr org update-webhook <id> --active off                            Disable webhook
  brokkr org update-webhook <id> --endpoint https://new.com/hook         Change endpoint
  brokkr org update-webhook <id> --events DEVICE_LISTING_UPDATED --json`,
    )
    .action(
      async (
        idArg: string | undefined,
        flags: { endpoint?: string; description?: string; events?: string; active?: string; json: boolean },
      ) => {
        const client = getAuthenticatedClient();
        let webhookId = idArg;
        let current;
        if (!webhookId) {
          const webhooks = await withSpinner('Fetching webhooks...', async () => {
            const result = await listWebhooks(client, { page: 1, pageSize: 100 });
            return result.data;
          });

          if (webhooks.length === 0) {
            fail('No webhooks found');
          }

          p.intro(chalk.bold('Update Webhook'));

          webhookId = prompt(
            await p.select({
              message: 'Select webhook',
              options: webhooks.map((wh) => ({
                value: wh.id,
                label: wh.endpoint,
                hint: `${wh.events.length} events · ${wh.isActive ? 'active' : 'inactive'}`,
              })),
            }),
          );

          current = webhooks.find((wh) => wh.id === webhookId)!;
        } else {
          current = await withSpinner('Fetching webhook...', async () => {
            return getWebhook(client, webhookId!);
          });
        }

        if (flags.endpoint) {
          validateHttpsUrl(flags.endpoint, '--endpoint');
        }

        let endpoint = flags.endpoint ?? current.endpoint;
        let description = flags.description ?? current.description ?? undefined;
        let events = flags.events ? parseWebhookEvents(flags.events) : current.events;
        let isActive = flags.active !== undefined ? parseToggle(flags.active, '--active') : current.isActive;

        const isInteractive = !idArg;
        if (isInteractive) {
          endpoint = prompt(
            await p.text({
              message: 'Endpoint URL',
              initialValue: current.endpoint,
              validate: (v) => {
                try {
                  const url = new URL(v);
                  if (url.protocol !== 'https:') return 'Must use HTTPS';
                } catch {
                  return 'Must be a valid HTTPS URL';
                }
              },
            }),
          );

          const desc = prompt(
            await p.text({
              message: 'Description (optional)',
              initialValue: current.description ?? '',
            }),
          );
          description = desc || undefined;

          events = prompt(
            await p.multiselect({
              message: 'Events',
              options: VALID_EVENTS.map((e) => ({
                value: e,
                label: e,
              })),
              initialValues: current.events,
              required: true,
            }),
          );

          isActive = prompt(
            await p.confirm({
              message: 'Active?',
              initialValue: current.isActive,
            }),
          );
        }

        const result = await withSpinner('Updating webhook...', async () => {
          return updateWebhook(client, webhookId!, {
            endpoint,
            description,
            events,
            isActive,
          });
        });

        if (flags.json) {
          renderJson(result);
          return;
        }

        ok(`Webhook ${chalk.bold(result.id)} updated`);
      },
    );
}
