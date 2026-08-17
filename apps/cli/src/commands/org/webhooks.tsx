import { Command } from 'commander';
import React from 'react';
import { getAuthenticatedClient } from '../../core/client.js';
import {
  webhookDeliveryListColumns,
  webhookDetailFields,
  webhookListColumns,
  webhookStatsFields,
} from '../../core/org/columns.js';
import { getWebhook, getWebhookStats, listWebhookDeliveries, listWebhooks } from '../../core/org/webhooks.js';
import { DetailContent } from '../../tui/components/detail-view.js';
import { StaticTable } from '../../tui/components/static-table.js';
import { renderOnce } from '../../tui/render-once.js';
import {
  fetchPage,
  paginationFooter,
  paginationOptions,
  renderJson,
  withSpinner,
  type PaginationFlags,
} from '../../ui/table.js';

export function registerWebhooksCommand(parent: Command): void {
  const webhooks = paginationOptions(
    parent
      .command('webhooks')
      .description('List webhooks, or show one by ID')
      .argument('[id]', 'Webhook ID to show details for'),
  )
    .addHelpText(
      'after',
      `
Sub-commands:
  brokkr org webhooks deliveries                 List webhook deliveries
  brokkr org webhooks stats                      Show webhook statistics

Examples:
  brokkr org webhooks --json                            List all webhooks as JSON
  brokkr org webhooks --page 2 --page-size 50 --json    Paginate the list
  brokkr org webhooks <id> --json                       Get webhook details
  brokkr org webhooks deliveries --json                 List deliveries as JSON
  brokkr org webhooks deliveries --page 2 --json        Paginate deliveries
  brokkr org webhooks stats --json                      Get webhook stats as JSON`,
    )
    .action(async (id: string | undefined, flags: PaginationFlags, cmd: Command) => {
      if (id?.startsWith('-')) {
        cmd.help();
        return;
      }
      if (id) {
        await showWebhook(id, flags.json);
      } else {
        await listWebhooksAction(flags);
      }
    });

  paginationOptions(webhooks.command('deliveries').description('List webhook deliveries')).action(
    async (flags: PaginationFlags) => {
      await listDeliveriesAction(flags);
    },
  );

  webhooks
    .command('stats')
    .description('Show webhook statistics')
    .option('--json', 'Output as JSON', false)
    .action(async (flags: { json: boolean }) => {
      await showStatsAction(flags.json);
    });
}

async function listWebhooksAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching webhooks...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listWebhooks(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Webhooks"
      columns={webhookListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr org webhooks')}
    />,
  );
}

async function showWebhook(webhookId: string, json: boolean): Promise<void> {
  const webhook = await withSpinner(`Fetching webhook ${webhookId}...`, async () => {
    const client = getAuthenticatedClient();
    return getWebhook(client, webhookId);
  });

  if (json) {
    renderJson(webhook);
    return;
  }

  renderOnce(<DetailContent title="Webhook" subtitle={webhook.id} fields={webhookDetailFields(webhook)} />);
}

async function listDeliveriesAction(flags: PaginationFlags): Promise<void> {
  const result = await withSpinner('Fetching webhook deliveries...', async () => {
    const client = getAuthenticatedClient();
    return fetchPage((query) => listWebhookDeliveries(client, query), flags);
  });

  if (flags.json) {
    renderJson(result);
    return;
  }

  renderOnce(
    <StaticTable
      title="Webhook Deliveries"
      columns={webhookDeliveryListColumns}
      rows={result.data}
      footer={paginationFooter(result.meta, 'brokkr org webhooks deliveries')}
    />,
  );
}

async function showStatsAction(json: boolean): Promise<void> {
  const stats = await withSpinner('Fetching webhook stats...', async () => {
    const client = getAuthenticatedClient();
    return getWebhookStats(client);
  });

  if (json) {
    renderJson(stats);
    return;
  }

  renderOnce(<DetailContent title="Webhook Statistics" fields={webhookStatsFields(stats)} />);
}
