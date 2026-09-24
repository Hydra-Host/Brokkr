import type { DeviceBootTrail } from '@repo/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Radar } from 'lucide-react';
import { bootPollInterval } from '../hooks/boot-poll';
import { diagnosticsKeys, useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { BootReadinessFindings } from './boot-readiness-findings';
import { BootTrailLine } from './boot-trail-line';
import type { DiagnosticDevice } from './diagnostic-header-lines';

const PXE_SOURCE_REASON: Record<NonNullable<DeviceBootTrail['pxeMacSource']>, string> = {
  marker: 'chosen because the bridge recorded a boot for it',
  address: 'chosen because it holds an IP address',
  'name-order': 'chosen by interface name; no address and no boot recorded',
};

export function pxeSourceReason(source: DeviceBootTrail['pxeMacSource']): string {
  return source === null ? '' : PXE_SOURCE_REASON[source];
}

export function BootDiagnostics({ device }: { device: DiagnosticDevice }) {
  const api = useDiagnosticsApi();
  const trailQuery = useQuery({
    queryKey: diagnosticsKeys.bootTrail(device.id),
    queryFn: () => api.bootTrail(device.id),
    refetchInterval: ({ state }) => bootPollInterval(device.status, state.data?.bootExpected.expected ?? null),
  });
  const trail = trailQuery.data ?? null;
  const bootExpected = trail === null ? null : trail.bootExpected.expected;
  const readinessQuery = useQuery({
    queryKey: diagnosticsKeys.bootReadiness(device.id),
    queryFn: () => api.bootReadiness(device.id),
    refetchInterval: bootPollInterval(device.status, bootExpected),
  });
  const readiness = readinessQuery.error === null ? (readinessQuery.data ?? null) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-5 w-5" />
            Boot trail
          </CardTitle>
          <CardDescription>
            The last PXE decision and the last iPXE chain hit the zone bridge recorded for {device.displayName}. Markers
            live 7 days (PXE) and 24 hours (chain).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {trailQuery.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : trailQuery.isError ? (
            <p className="text-muted-foreground">The boot trail could not be loaded.</p>
          ) : trail === null ? null : (
            <>
              <BootTrailLine trail={trail.trail} />
              <p className="text-muted-foreground">
                {trail.bootExpected.expected
                  ? `Boot expected since ${new Date(trail.bootExpected.since ?? '').toLocaleTimeString()} (${trail.bootExpected.reason}).`
                  : 'No network boot is expected now, so a missing PXE request is not a finding.'}
              </p>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">pxe mac</dt>
                <dd>
                  {trail.pxeMac ? (
                    <>
                      <span className="text-xs">{trail.pxeInterface} · </span>
                      <ClickToCopyString value={trail.pxeMac} className="text-xs" />
                      <span className="text-muted-foreground block text-xs">{pxeSourceReason(trail.pxeMacSource)}</span>
                    </>
                  ) : (
                    'none'
                  )}
                </dd>
                {trail.candidateMacs.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">other macs</dt>
                    <dd className="font-mono text-xs">{trail.candidateMacs.join(', ')}</dd>
                  </>
                )}
              </dl>
              {trail.trail.chainDeviceMismatch && (
                <p className="text-destructive">The bridge matched this MAC to another device.</p>
              )}
              <p className="text-muted-foreground text-xs">
                {trail.zoneId
                  ? `Read from zone ${trail.zoneId} by exact key.`
                  : 'The device has no zone, so no bridge Redis was read.'}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Readiness</CardTitle>
          <CardDescription>
            Hub prefix checks and trail-derived codes. Severity and remedy come from the shared registry.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {readinessQuery.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <BootReadinessFindings
                readiness={readiness}
                error={readinessQuery.error}
                bootExpected={bootExpected}
                emptyText="No hub-side finding. The bridge's own startup checks are not visible here yet."
                forbiddenText="Not permitted to evaluate the prefix. The prefix checks need ipam:read; the boot trail still reads."
              />
              {readiness !== null && (
                <p className="text-muted-foreground text-xs">
                  Evaluated: hub prefix checks{' '}
                  {readiness.evaluated.hubPrefix ? `(${readiness.prefixSelection} prefix)` : 'not evaluated'} · boot
                  trail {readiness.evaluated.bootTrail ? 'read' : 'unreadable'}.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
