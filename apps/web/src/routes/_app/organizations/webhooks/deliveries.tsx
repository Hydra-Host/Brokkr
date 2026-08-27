import type { WebhookDeliveryResponse } from '@repo/api-client';
import { ServerDataTable } from '@repo/domain-ui/components/server-data-table';
import type { ServerColumnDef } from '@repo/domain-ui/hooks/use-server-table';
import { useServerTable } from '@repo/domain-ui/hooks/use-server-table';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';
import { cn } from '@repo/ui/utils';
import { formatShortDateTime } from '@repo/utils';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Activity, CheckCircle2, Copy, Eye, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
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

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'SUCCESS':
      return (
        <Badge variant="outline" className="border-status-online text-status-online">
          Success
        </Badge>
      );
    case 'FAILED':
      return <Badge variant="destructive">Failed</Badge>;
    case 'RETRYING':
      return (
        <Badge variant="outline" className="border-amber-500 text-amber-500">
          Retrying
        </Badge>
      );
    case 'PENDING':
      return <Badge variant="secondary">Pending</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function HttpStatusBadge({ status }: { status: number | null }) {
  if (status === null) return <span className="text-muted-foreground text-sm">—</span>;
  const variant =
    status >= 200 && status < 300 ? 'text-status-online' : status >= 400 ? 'text-red-500' : 'text-amber-500';
  return <code className={cn('text-sm font-medium', variant)}>{status}</code>;
}

export const Route = createFileRoute('/_app/organizations/webhooks/deliveries')({
  component: DeliveriesPage,
});

function DeliveriesPage() {
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDeliveryResponse | null>(null);
  const { copy, copied } = useCopyToClipboard();

  const { mutateAsync: retryDelivery, isPending: isRetrying } = tsr.retryWebhookDelivery.useMutation();

  const handleRetry = useCallback(
    async (deliveryId: string) => {
      await retryDelivery({ params: { deliveryId }, body: {} });
    },
    [retryDelivery],
  );

  const handleCopyPayload = async (payload: unknown) => {
    await copy(JSON.stringify(payload, null, 2));
  };

  const columns = useMemo<ServerColumnDef<WebhookDeliveryResponse>[]>(
    () => [
      {
        accessorKey: 'eventType',
        header: 'Event',
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-xs">
            {formatEventName(row.original.eventType)}
          </Badge>
        ),
      },
      {
        accessorKey: 'webhookEndpoint',
        header: 'Endpoint',
        cell: ({ row }) => (
          <code className="text-muted-foreground block max-w-[200px] truncate text-xs">
            {row.original.webhookEndpoint}
          </code>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'statusCode',
        header: 'Response',
        cell: ({ row }) => <HttpStatusBadge status={row.original.statusCode} />,
      },
      {
        accessorKey: 'attemptNumber',
        header: 'Attempts',
        cell: ({ row }) => <span className="text-muted-foreground text-sm">{row.original.attemptNumber} / 5</span>,
      },
      {
        accessorKey: 'createdAt',
        header: 'Sent At',
        sortField: 'createdAt',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{formatShortDateTime(row.original.createdAt)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            {(row.original.status === 'FAILED' || row.original.status === 'SUCCESS') && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleRetry(row.original.id)}
                disabled={isRetrying}
                title="Retry delivery"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSelectedDelivery(row.original)}
              title="View details"
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ],
    [handleRetry, isRetrying],
  );

  const table = useServerTable<WebhookDeliveryResponse>({ name: 'webhook-deliveries', columns });

  const {
    data: deliveriesData,
    isPending,
    isFetching,
  } = tsr.getWebhookDeliveries.useQuery({
    queryKey: ['webhook-deliveries', table.query],
    queryData: { query: table.query },
    placeholderData: keepPreviousData,
  });

  const deliveries = deliveriesData?.status === 200 ? deliveriesData.body.data : [];
  const meta = deliveriesData?.status === 200 ? deliveriesData.body.meta : undefined;

  if (!isPending && !isFetching && deliveries.length === 0 && !table.search) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Activity className="text-muted-foreground mb-4 h-12 w-12" />
        <h3 className="text-lg font-medium">No Deliveries</h3>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          Webhook deliveries will appear here once events are triggered.
        </p>
      </div>
    );
  }

  return (
    <>
      <ServerDataTable
        table={table}
        data={deliveries}
        meta={meta}
        isPending={isPending}
        isFetching={isFetching && !isPending}
        searchPlaceholder="Search deliveries..."
        searchLabel="Search deliveries"
        emptyMessage="No deliveries found"
      />

      <Sheet open={!!selectedDelivery} onOpenChange={(open) => !open && setSelectedDelivery(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Delivery Details</SheetTitle>
            <SheetDescription>Details for delivery to {selectedDelivery?.webhookEndpoint}</SheetDescription>
          </SheetHeader>

          {selectedDelivery && (
            <div className="mt-6 space-y-6">
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Status</h4>
                <div className="flex items-center gap-3">
                  <StatusBadge status={selectedDelivery.status} />
                  <HttpStatusBadge status={selectedDelivery.statusCode} />
                  <span className="text-muted-foreground text-sm">Attempt {selectedDelivery.attemptNumber} / 5</span>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Delivery Information</h4>
                <div className="bg-muted space-y-2 rounded-md p-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Delivery ID</span>
                    <code className="text-xs">{selectedDelivery.id}</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Event</span>
                    <Badge variant="secondary" className="text-xs">
                      {formatEventName(selectedDelivery.eventType)}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Endpoint</span>
                    <code className="max-w-[250px] truncate text-xs">{selectedDelivery.webhookEndpoint}</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sent At</span>
                    <span>{formatShortDateTime(selectedDelivery.createdAt)}</span>
                  </div>
                  {selectedDelivery.deliveredAt && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Delivered At</span>
                      <span>{formatShortDateTime(selectedDelivery.deliveredAt)}</span>
                    </div>
                  )}
                </div>
              </div>

              {selectedDelivery.error && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Error</h4>
                  <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                    {selectedDelivery.error}
                  </div>
                </div>
              )}

              {selectedDelivery.responseBody && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Response Body</h4>
                  <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{selectedDelivery.responseBody}</pre>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Payload</h4>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleCopyPayload(selectedDelivery.payload)}
                  >
                    {copied ? (
                      <CheckCircle2 className="text-status-online mr-1 h-3 w-3" />
                    ) : (
                      <Copy className="mr-1 h-3 w-3" />
                    )}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <pre className="bg-muted max-h-[300px] overflow-x-auto overflow-y-auto rounded-md p-3 text-xs">
                  {JSON.stringify(selectedDelivery.payload, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
