import { CUSTOMER_HEALTH_KEYS, type DeviceHealthSummary, type DeviceReachability } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import type { ReactNode } from 'react';
import { HEALTH_CHECK_COLUMNS, HealthCheckStatusIcon, isDormantCheck } from './health-check-status-icon';

const REACHABILITY_VARIANT: Record<DeviceReachability, 'success' | 'warning' | 'destructive' | 'outline'> = {
  ok: 'success',
  'auth-failed': 'warning',
  unreachable: 'destructive',
  unconfigured: 'outline',
  unknown: 'outline',
};

export function DeviceHealthSummaryCard({
  summary,
  line,
  deployedOs,
  action,
  message,
}: {
  summary: DeviceHealthSummary;
  line: string;
  deployedOs: boolean;
  action?: ReactNode;
  message?: string | null;
}) {
  const columns =
    summary.view === 'customer'
      ? HEALTH_CHECK_COLUMNS.filter((c) => CUSTOMER_HEALTH_KEYS.has(c.key))
      : HEALTH_CHECK_COLUMNS;
  const reachability = summary.checks?.reachability ?? null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            Latest
            {reachability !== null && <Badge variant={REACHABILITY_VARIANT[reachability]}>{reachability}</Badge>}
          </CardTitle>
          <CardDescription>{line}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className="space-y-3">
        {summary.checks === null ? (
          <p className="text-muted-foreground text-sm">No probe result to show.</p>
        ) : (
          <div className="flex flex-wrap gap-4">
            {columns.map((column) => (
              <div key={column.key} className="flex flex-col items-center gap-1 text-xs">
                <HealthCheckStatusIcon
                  value={summary.checks?.[column.key] ?? null}
                  label={column.label}
                  dormant={isDormantCheck(column.key, deployedOs)}
                />
                <span className="text-muted-foreground">{column.label}</span>
              </div>
            ))}
          </div>
        )}
        {summary.reason && <p className="text-sm">Reason: {summary.reason}</p>}
        {summary.icmpFiltered && (
          <p className="text-muted-foreground text-sm">
            ICMP does not answer; the BMC is reachable over IPMI or Redfish.
          </p>
        )}
        {message && <p className="text-muted-foreground text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
