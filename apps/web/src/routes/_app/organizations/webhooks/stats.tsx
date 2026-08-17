import type { WebhookStats } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { createFileRoute } from '@tanstack/react-router';
import { Activity, CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react';
import { BootScreen } from '~/components/boot-screen';
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

function timeAgo(date: Date | string) {
  const now = new Date();
  const then = new Date(date);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function HttpStatusBadge({ status }: { status: number | null }) {
  if (status === null) return <span className="text-muted-foreground text-sm">—</span>;
  const variant =
    status >= 200 && status < 300 ? 'text-status-online' : status >= 400 ? 'text-red-500' : 'text-amber-500';
  return <code className={`text-sm font-medium ${variant}`}>{status}</code>;
}

export const Route = createFileRoute('/_app/organizations/webhooks/stats')({
  component: StatsPage,
});

function StatsPage() {
  const { data: statsData, isPending } = tsr.getWebhookStats.useQuery({
    queryKey: ['webhook-stats'],
  });

  if (isPending) {
    return <BootScreen />;
  }

  const stats: WebhookStats | undefined = statsData?.status === 200 ? statsData.body : undefined;

  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Activity className="text-muted-foreground mb-4 h-12 w-12" />
        <h3 className="text-lg font-medium">No Stats Available</h3>
        <p className="text-muted-foreground mt-1 max-w-sm text-sm">
          Stats will appear once webhooks have been created and deliveries attempted.
        </p>
      </div>
    );
  }

  const activePercent = stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0;

  const successCount = stats.recentDeliveries.filter((d) => d.status === 'SUCCESS').length;
  const failedCount = stats.recentDeliveries.filter((d) => d.status === 'FAILED').length;
  const retryingCount = stats.recentDeliveries.filter((d) => d.status === 'RETRYING').length;
  const pendingCount = stats.recentDeliveries.filter((d) => d.status === 'PENDING').length;
  const totalRecent = stats.recentDeliveries.length;
  const healthScore = totalRecent > 0 ? Math.round((successCount / totalRecent) * 100) : 100;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Webhooks</CardDescription>
            <CardTitle className="text-3xl">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active Webhooks</CardDescription>
            <CardTitle className="text-3xl">
              {stats.active} <span className="text-muted-foreground text-sm font-normal">({activePercent}%)</span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Active with Failures</CardDescription>
            <CardTitle className="text-3xl">{stats.failed}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Health Score</CardDescription>
            <CardTitle className="text-3xl">{healthScore}%</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {totalRecent > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Delivery Performance</CardTitle>
            <CardDescription>Based on the last {totalRecent} deliveries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 space-y-2">
              <div className="flex h-3 overflow-hidden rounded-full">
                {successCount > 0 && (
                  <div className="bg-status-online" style={{ width: `${(successCount / totalRecent) * 100}%` }} />
                )}
                {failedCount > 0 && (
                  <div className="bg-red-500" style={{ width: `${(failedCount / totalRecent) * 100}%` }} />
                )}
                {retryingCount > 0 && (
                  <div className="bg-amber-500" style={{ width: `${(retryingCount / totalRecent) * 100}%` }} />
                )}
                {pendingCount > 0 && (
                  <div className="bg-muted-foreground/30" style={{ width: `${(pendingCount / totalRecent) * 100}%` }} />
                )}
              </div>
              <div className="flex gap-4 text-xs">
                <div className="flex items-center gap-1">
                  <span className="bg-status-online h-2 w-2 rounded-full" />
                  Successful ({successCount})
                </div>
                <div className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-red-500" />
                  Failed ({failedCount})
                </div>
                <div className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  Retrying ({retryingCount})
                </div>
                <div className="flex items-center gap-1">
                  <span className="bg-muted-foreground/30 h-2 w-2 rounded-full" />
                  Pending ({pendingCount})
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {stats.recentDeliveries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.recentDeliveries.slice(0, 10).map((delivery) => (
                <div key={delivery.id} className="flex items-center gap-3 text-sm">
                  {delivery.status === 'SUCCESS' ? (
                    <CheckCircle2 className="text-status-online h-4 w-4 shrink-0" />
                  ) : delivery.status === 'FAILED' ? (
                    <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                  ) : delivery.status === 'RETRYING' ? (
                    <RefreshCw className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <Clock className="text-muted-foreground h-4 w-4 shrink-0" />
                  )}
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {formatEventName(delivery.eventType)}
                  </Badge>
                  <span className="text-muted-foreground truncate">
                    {delivery.webhook?.endpoint ?? 'Unknown endpoint'}
                  </span>
                  {delivery.errorMessage && (
                    <span className="text-destructive max-w-[200px] truncate text-xs">{delivery.errorMessage}</span>
                  )}
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">{timeAgo(delivery.createdAt)}</span>
                  {delivery.httpStatus && <HttpStatusBadge status={delivery.httpStatus} />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
