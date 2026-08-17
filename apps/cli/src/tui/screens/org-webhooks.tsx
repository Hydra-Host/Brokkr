import React from 'react';
import type { CliApiClient } from '../../core/client.js';
import {
  webhookDeliveryListColumns,
  webhookDetailFields,
  webhookListColumns,
  webhookStatsFields,
} from '../../core/org/columns.js';
import {
  getWebhook,
  getWebhookStats,
  listWebhookDeliveries,
  listWebhooks,
  type WebhookDeliveryListItem,
  type WebhookListItem,
} from '../../core/org/webhooks.js';
import { DetailView } from '../components/detail-view.js';
import { ErrorView } from '../components/error-view.js';
import { Loading } from '../components/loading.js';
import { NavTable } from '../components/nav-table.js';
import { useAsync, usePaginatedAsync } from '../hooks.js';
import { useRouter } from '../router.js';

export function WebhooksListScreen({ client }: { client: CliApiClient }) {
  const { push, pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listWebhooks(client, query),
  );

  if (loading) return <Loading message="Fetching webhooks..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<WebhookListItem>
      columns={webhookListColumns}
      rows={result?.data ?? []}
      onSelect={(row) => push({ screen: 'org-webhook-detail', params: { id: row.id }, title: row.endpoint })}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function WebhookDetailScreen({ client, id }: { client: CliApiClient; id: string }) {
  const { pop } = useRouter();
  const { data: webhook, loading, error } = useAsync(() => getWebhook(client, id), [id]);

  if (loading) return <Loading message="Loading webhook..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!webhook) return <ErrorView message="Webhook not found" onBack={pop} />;

  return <DetailView title="Webhook" subtitle={webhook.id} fields={webhookDetailFields(webhook)} onBack={pop} />;
}

export function WebhookDeliveriesListScreen({ client }: { client: CliApiClient }) {
  const { pop } = useRouter();
  const { result, loading, error, nextPage, prevPage, pageInfo } = usePaginatedAsync((query) =>
    listWebhookDeliveries(client, query),
  );

  if (loading) return <Loading message="Fetching webhook deliveries..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;

  return (
    <NavTable<WebhookDeliveryListItem>
      columns={webhookDeliveryListColumns}
      rows={result?.data ?? []}
      onBack={pop}
      pageInfo={pageInfo}
      onNextPage={nextPage}
      onPrevPage={prevPage}
    />
  );
}

export function WebhookStatsScreen({ client }: { client: CliApiClient }) {
  const { pop } = useRouter();
  const { data: stats, loading, error } = useAsync(() => getWebhookStats(client), []);

  if (loading) return <Loading message="Fetching webhook stats..." />;
  if (error) return <ErrorView message={error} onBack={pop} />;
  if (!stats) return <ErrorView message="No stats data" onBack={pop} />;

  return <DetailView title="Webhook Statistics" fields={webhookStatsFields(stats)} onBack={pop} />;
}
