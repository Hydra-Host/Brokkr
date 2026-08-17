import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { AlertTriangle } from 'lucide-react';
import { SummaryRow } from '~/components/summary-row';
import { tsr } from '~/lib/api';

interface ResolvedBinding {
  bridgeId: string;
  displayName: string;
  iface: string;
}

export function resolveBindingDisplayNames(
  bindings: ReadonlyArray<{ bridgeId: string; iface: string }>,
  bridges: ReadonlyArray<{ id: string; name: string }>,
): ResolvedBinding[] {
  const bridgeById = new Map(bridges.map((b) => [b.id, b]));
  return bindings.map((binding) => ({
    bridgeId: binding.bridgeId,
    displayName: bridgeById.get(binding.bridgeId)?.name ?? binding.bridgeId,
    iface: binding.iface,
  }));
}

export function PrefixVrrpSummaryCard({
  prefixId,
  vrrpVipId,
  zoneId,
}: {
  prefixId: string;
  vrrpVipId: string | null;
  zoneId: string | null;
}) {
  const hasZone = zoneId !== null;

  const vipQuery = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', vrrpVipId],
    queryData: { params: { id: vrrpVipId ?? '' } },
    enabled: hasZone && vrrpVipId !== null,
  });

  const bindingsQuery = tsr.getPrefixVrrpBindings.useQuery({
    queryKey: ['prefix', prefixId, 'vrrp-bindings'],
    queryData: { params: { id: prefixId } },
    enabled: hasZone,
  });

  const bridgesQuery = tsr.getBridges.useQuery({
    queryKey: ['bridges', zoneId],
    queryData: { query: { pageSize: 100, zoneId: zoneId ?? undefined } },
    enabled: hasZone,
  });

  if (!hasZone) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>VRRP</CardTitle>
        </CardHeader>
        <CardContent>
          <span className="text-muted-foreground text-sm">Assign this prefix to a zone to configure VRRP.</span>
        </CardContent>
      </Card>
    );
  }

  const isNetworkError = vipQuery.isError || bindingsQuery.isError || bridgesQuery.isError;
  const hasNon200 =
    (vrrpVipId !== null && vipQuery.data && vipQuery.data.status !== 200) ||
    (bindingsQuery.data && bindingsQuery.data.status !== 200) ||
    (bridgesQuery.data && bridgesQuery.data.status !== 200);

  if (isNetworkError || hasNon200) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>VRRP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" />
            Failed to load VRRP configuration.
          </div>
        </CardContent>
      </Card>
    );
  }

  const isPending = bindingsQuery.isPending || bridgesQuery.isPending || (vrrpVipId !== null && vipQuery.isPending);

  if (isPending) {
    return <Skeleton className="h-36" />;
  }

  if (!vrrpVipId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>VRRP</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Not configured</Badge>
            <span className="text-muted-foreground text-sm">No VRRP floating IP is assigned to this prefix.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const vipAddress = vipQuery.data?.status === 200 ? vipQuery.data.body.address : null;
  const rawBindings = bindingsQuery.data?.status === 200 ? bindingsQuery.data.body : [];
  const bridges = bridgesQuery.data?.status === 200 ? bridgesQuery.data.body.data : [];
  const bridgeMeta = bridgesQuery.data?.status === 200 ? bridgesQuery.data.body.meta : null;
  const bridgesTruncated = bridgeMeta != null && bridgeMeta.totalPages > 1;
  const resolved = resolveBindingDisplayNames(rawBindings, bridges);

  return (
    <Card>
      <CardHeader>
        <CardTitle>VRRP</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-border divide-y">
          <SummaryRow label="VIP address">
            <span className="font-mono">{vipAddress ?? '—'}</span>
          </SummaryRow>

          <div className="py-1.5">
            <span className="text-muted-foreground text-sm">Bridge bindings</span>
            {resolved.length === 0 ? (
              <p className="text-muted-foreground mt-1 text-sm">No bridges bound.</p>
            ) : (
              <>
                <div className="divide-border mt-1 divide-y">
                  {resolved.map((entry) => (
                    <div key={entry.bridgeId} className="flex items-center justify-between py-1">
                      <span className="text-sm font-medium">{entry.displayName}</span>
                      <span className="font-mono text-xs">{entry.iface}</span>
                    </div>
                  ))}
                </div>
                {bridgesTruncated && (
                  <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                    <AlertTriangle className="h-3 w-3" />
                    Showing first 100 of {bridgeMeta?.totalItems} bridges — some names may be unresolved.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
