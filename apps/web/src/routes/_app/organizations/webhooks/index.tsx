import { createFileRoute, Link } from '@tanstack/react-router';
import { Edit, MoreHorizontal, Plus, Trash2, Webhook } from 'lucide-react';
import { useMemo } from 'react';

import type { Webhook as WebhookType } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { ServerDataTable } from '@repo/ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/ui/hooks/use-server-table';
import { useServerTable } from '@repo/ui/hooks/use-server-table';
import { formatShortDate } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { tsr } from '~/lib/api';

const EVENT_LABELS: Record<string, string> = {
  DEVICE_LISTING_UPDATED: 'Device Listing Updated',
  DEVICE_LISTING_CREATED: 'Device Listing Created',
  DEVICE_LISTING_DECOMMISSIONED: 'Device Listing Decommissioned',
  DEPLOYMENT_INTERRUPTED: 'Deployment Interrupted',
  DEPLOYMENT_INTERRUPTION_COMPLETED: 'Deployment Interruption Completed',
};

function formatEventName(event: string) {
  return EVENT_LABELS[event] ?? event;
}

export const Route = createFileRoute('/_app/organizations/webhooks/')({
  component: WebhooksTab,
});

function WebhooksTab() {
  const columns = useMemo<ServerColumnDef<WebhookType>[]>(
    () => [
      {
        accessorKey: 'endpoint',
        header: 'Endpoint',
        cell: ({ row }) => <code className="block max-w-[300px] truncate text-sm">{row.original.endpoint}</code>,
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ row }) => (
          <span className="text-muted-foreground block max-w-[200px] truncate text-sm">
            {row.original.description || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'events',
        header: 'Events',
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.events.map((event, idx) => (
              <Badge key={`${event}-${idx}`} variant="secondary" className="text-xs">
                {formatEventName(event)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        accessorKey: 'isActive',
        header: 'Status',
        cell: ({ row }) =>
          row.original.isActive ? (
            <Badge variant="outline" className="border-status-online text-status-online">
              Active
            </Badge>
          ) : (
            <Badge variant="secondary">Inactive</Badge>
          ),
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        sortField: 'createdAt',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{formatShortDate(row.original.createdAt)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/organizations/webhooks/edit/$webhookId" params={{ webhookId: row.original.id }}>
                    <Edit className="mr-2 h-4 w-4" />
                    Edit
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/organizations/webhooks/delete/$webhookId" params={{ webhookId: row.original.id }}>
                    <Trash2 className="text-destructive mr-2 h-4 w-4" />
                    Delete
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [],
  );

  const table = useServerTable<WebhookType>({ name: 'webhooks', columns });

  const {
    data: webhooksData,
    isPending,
    isFetching,
  } = tsr.listWebhooks.useQuery({
    queryKey: ['webhooks', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const webhooks = webhooksData?.status === 200 ? webhooksData.body.data : [];
  const meta = webhooksData?.status === 200 ? webhooksData.body.meta : undefined;

  if (!isPending && !isFetching && webhooks.length === 0 && !table.search) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Webhook className="text-muted-foreground mb-4 h-12 w-12" />
        <h3 className="text-lg font-medium">No Webhooks</h3>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          Create a webhook to receive event notifications at your endpoint.
        </p>
        <Button asChild className="mt-4">
          <Link to="/organizations/webhooks/create">
            <Plus className="mr-2 h-4 w-4" />
            Create Your First Webhook
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <ServerDataTable
      table={table}
      data={webhooks}
      meta={meta}
      isPending={isPending}
      isFetching={isFetching && !isPending}
      searchPlaceholder="Search webhooks..."
      searchLabel="Search webhooks"
      emptyMessage="No webhooks found"
    />
  );
}
