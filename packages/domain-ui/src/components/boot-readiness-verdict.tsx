import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useQuery } from '@tanstack/react-query';
import { diagnosticsKeys, useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { pxeSourceReason } from './boot-diagnostics';
import { BootReadinessFindings } from './boot-readiness-findings';

export function BootReadinessVerdict({ deviceId }: { deviceId: string }) {
  const api = useDiagnosticsApi();
  const query = useQuery({
    queryKey: diagnosticsKeys.bootReadiness(deviceId),
    queryFn: () => api.bootReadiness(deviceId),
  });
  if (query.isPending) return null;
  const readiness = query.data ?? null;
  const pxeLine =
    readiness !== null && readiness.pxeInterface !== null && readiness.pxeMac !== null
      ? ` PXE interface: ${readiness.pxeInterface} · ${readiness.pxeMac} (${pxeSourceReason(readiness.pxeMacSource)}).`
      : '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Boot readiness</CardTitle>
        <CardDescription>{`Findings the hub can see before this provision starts.${pxeLine}`}</CardDescription>
      </CardHeader>
      <CardContent>
        <BootReadinessFindings
          readiness={query.data ?? null}
          error={query.error}
          bootExpected={null}
          emptyText="No hub-side finding."
          forbiddenText="Not permitted to evaluate the prefix. The prefix checks need ipam:read."
        />
      </CardContent>
    </Card>
  );
}
