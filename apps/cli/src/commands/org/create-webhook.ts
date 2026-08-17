import * as p from '@clack/prompts';
import { WebhookEventTypeSchema } from '@repo/api-client';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAuthenticatedClient } from '../../core/client.js';
import { createWebhook, parseWebhookEvents } from '../../core/org/webhooks.js';
import { ok, parseToggle, validateHttpsUrl, warn } from '../../ui/format.js';
import { prompt } from '../../ui/prompt.js';
import { renderJson, withSpinner } from '../../ui/table.js';

const VALID_EVENTS = WebhookEventTypeSchema.options;

export function registerCreateWebhookCommand(parent: Command): void {
  parent
    .command('create-webhook')
    .description('Create a new webhook')
    .argument('[endpoint]', 'Webhook endpoint URL (https)')
    .option('--description <desc>', 'Webhook description')
    .option('--events <events>', 'Comma-separated event types')
    .option('--active <on|off>', 'Whether webhook is active (default: on)')
    .option('--json', 'Output as JSON', false)
    .addHelpText(
      'after',
      `
Event types:
  DEVICE_LISTING_UPDATED
  DEVICE_LISTING_CREATED
  DEVICE_LISTING_DECOMMISSIONED
  DEPLOYMENT_INTERRUPTED
  DEPLOYMENT_INTERRUPTION_COMPLETED

Examples:
  brokkr org create-webhook                                              Interactive mode
  brokkr org create-webhook https://example.com/hook --events DEVICE_LISTING_UPDATED,DEVICE_LISTING_CREATED
  brokkr org create-webhook https://example.com/hook --events DEVICE_LISTING_UPDATED --description "My hook" --json`,
    )
    .action(
      async (
        endpointArg: string | undefined,
        flags: { description?: string; events?: string; active?: string; json: boolean },
      ) => {
        let endpoint = endpointArg;
        let description = flags.description;
        let events: string[] | undefined = flags.events ? parseWebhookEvents(flags.events) : undefined;
        let isActive = true;

        if (flags.active !== undefined) {
          isActive = parseToggle(flags.active, '--active');
        }

        if (!endpoint || !events) {
          p.intro(chalk.bold('Create Webhook'));
        }

        if (!endpoint) {
          endpoint = prompt(
            await p.text({
              message: 'Endpoint URL',
              placeholder: 'https://example.com/webhook',
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
        } else {
          validateHttpsUrl(endpoint, 'Endpoint URL');
        }

        if (description === undefined && !flags.events) {
          const desc = prompt(
            await p.text({
              message: 'Description (optional)',
              placeholder: 'Press enter to skip',
            }),
          );
          if (desc) description = desc;
        }

        if (!events) {
          const selected = prompt(
            await p.multiselect({
              message: 'Events to subscribe to',
              options: VALID_EVENTS.map((e) => ({ value: e, label: e })),
              required: true,
            }),
          );
          events = selected;
        }

        if (!flags.events && flags.active === undefined) {
          isActive = prompt(
            await p.confirm({
              message: 'Active?',
              initialValue: true,
            }),
          );
        }

        const client = getAuthenticatedClient();
        const result = await withSpinner('Creating webhook...', async () => {
          return createWebhook(client, {
            endpoint: endpoint!,
            description,
            events: events!,
            isActive,
          });
        });

        if (flags.json) {
          console.error(chalk.yellow('  Warning: output contains a secret that will not be shown again'));
          renderJson(result);
          return;
        }

        ok(`Webhook created (${chalk.bold(result.id)})`);
        console.log();
        warn('Save this signing secret — it will not be shown again:');
        console.log(`  ${chalk.bold(result.secret)}`);
      },
    );
}
