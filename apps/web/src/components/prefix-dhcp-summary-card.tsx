import type { DhcpMode } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { AlertTriangle } from 'lucide-react';
import { SummaryRow } from '~/components/summary-row';
import { tsr } from '~/lib/api';

export function modeBadgeVariant(mode: DhcpMode) {
  switch (mode) {
    case 'AUTHORITATIVE':
      return 'success';
    case 'PROXY':
      return 'info';
    case 'OFF':
      return 'outline';
  }
}

export function PrefixDhcpSummaryCard({ prefixId }: { prefixId: string }) {
  const configQuery = tsr.getPrefixDhcpConfig.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-config'],
    queryData: { params: { id: prefixId } },
  });

  const configData = configQuery.data?.status === 200 ? configQuery.data.body : null;
  const mode = configData?.dhcpMode;
  const isActive = mode === 'AUTHORITATIVE' || mode === 'PROXY';

  const servingQuery = tsr.getPrefixDhcpServing.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-serving'],
    queryData: { params: { id: prefixId } },
    enabled: isActive,
  });

  const reservationsQuery = tsr.getPrefixDhcpReservations.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-reservations'],
    queryData: { params: { id: prefixId } },
    enabled: isActive,
  });

  const leasesQuery = tsr.getPrefixDhcpLeases.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-leases'],
    queryData: { params: { id: prefixId } },
    enabled: mode === 'AUTHORITATIVE',
  });

  if (configQuery.isPending) {
    return <Skeleton className="h-48" />;
  }

  if (configQuery.isError || !configData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DHCP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" />
            Failed to load DHCP configuration.
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!isActive) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DHCP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            {mode === 'OFF' ? (
              <>
                <Badge variant="outline">OFF</Badge>
                <span className="text-muted-foreground text-sm">DHCP is explicitly disabled for this prefix.</span>
              </>
            ) : (
              <>
                <Badge variant="outline">Not configured</Badge>
                <span className="text-muted-foreground text-sm">DHCP has not been configured for this prefix.</span>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const supplementaryPending = servingQuery.isLoading || reservationsQuery.isLoading || leasesQuery.isLoading;

  if (supplementaryPending) {
    return <Skeleton className="h-48" />;
  }

  const supplementaryError = servingQuery.isError || reservationsQuery.isError || leasesQuery.isError;

  if (supplementaryError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DHCP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <SummaryRow label="Mode">
              <Badge variant={modeBadgeVariant(mode)}>{mode}</Badge>
            </SummaryRow>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4" />
              Failed to load DHCP details.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const serving = servingQuery.data?.status === 200 ? servingQuery.data.body : null;
  const reservations = reservationsQuery.data?.status === 200 ? reservationsQuery.data.body : null;
  const leases = leasesQuery.data?.status === 200 ? leasesQuery.data.body : null;

  const servingAddresses = [...new Set([serving?.nextServer, ...(serving?.dnsServers ?? [])].filter(Boolean))];

  return (
    <Card>
      <CardHeader>
        <CardTitle>DHCP</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-border divide-y">
          <SummaryRow label="Mode">
            <Badge variant={modeBadgeVariant(mode)}>{mode}</Badge>
          </SummaryRow>

          {mode === 'AUTHORITATIVE' && (
            <SummaryRow label="Lease TTL">
              {configData.dhcpLeaseTtlSeconds != null ? `${configData.dhcpLeaseTtlSeconds}s` : '600s (default)'}
            </SummaryRow>
          )}

          <SummaryRow label="iPXE target">{configData.ipxeBuildTarget}</SummaryRow>

          {servingAddresses.length > 0 && (
            <SummaryRow label="Serving addresses">
              <span className="text-right">{servingAddresses.join(', ')}</span>
            </SummaryRow>
          )}

          <SummaryRow label="Reservations">{reservations?.length ?? 0}</SummaryRow>

          {mode === 'AUTHORITATIVE' && <SummaryRow label="Active leases">{leases?.length ?? 0}</SummaryRow>}
        </div>
      </CardContent>
    </Card>
  );
}
