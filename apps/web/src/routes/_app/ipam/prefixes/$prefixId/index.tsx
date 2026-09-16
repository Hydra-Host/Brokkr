import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { getIpamStatusBadgeVariant } from '@repo/utils';
import { createFileRoute } from '@tanstack/react-router';
import { PrefixBondParametersCard } from '~/components/prefix-bond-parameters-card';
import { PrefixDhcpSummaryCard } from '~/components/prefix-dhcp-summary-card';
import { PrefixVrrpSummaryCard } from '~/components/prefix-vrrp-summary-card';
import { SummaryRow } from '~/components/summary-row';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/prefixes/$prefixId/')({
  component: PrefixOverview,
});

function PrefixOverview() {
  const { prefixId } = Route.useParams();

  const { data, isPending } = tsr.getPrefix.useQuery({
    queryKey: ['prefix', prefixId],
    queryData: { params: { id: prefixId } },
  });

  const prefix = data?.status === 200 ? data.body : null;

  const { data: zoneData, isError: zoneError } = tsr.getZoneById.useQuery({
    queryKey: ['zone', prefix?.zoneId],
    queryData: { params: { zoneId: prefix?.zoneId ?? '' } },
    enabled: !!prefix?.zoneId,
  });

  const { data: gatewayData, isError: gatewayError } = tsr.getIpAddress.useQuery({
    queryKey: ['ip-address', prefix?.gatewayIpId],
    queryData: { params: { id: prefix?.gatewayIpId ?? '' } },
    enabled: !!prefix?.gatewayIpId,
  });

  if (isPending) {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          {[1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-3 pt-6">
                {[1, 2, 3].map((j) => (
                  <Skeleton key={j} className="h-4 w-full" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!prefix) {
    return null;
  }

  const zoneName =
    zoneData?.status === 200 ? zoneData.body.name : prefix.zoneId ? (zoneError ? 'Failed to load' : '...') : undefined;
  const gatewayAddress =
    gatewayData?.status === 200 ? (
      <span className="font-mono">{gatewayData.body.address}</span>
    ) : prefix.gatewayIpId ? (
      gatewayError ? (
        'Failed to load'
      ) : (
        '...'
      )
    ) : undefined;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-border divide-y">
              <SummaryRow label="Prefix" nullFallback="--">
                <span className="font-mono">{prefix.prefix}</span>
              </SummaryRow>
              <SummaryRow label="Status" nullFallback="--">
                <Badge variant={getIpamStatusBadgeVariant(prefix.status)}>{prefix.status}</Badge>
              </SummaryRow>
              <SummaryRow label="Is Pool" nullFallback="--">
                <Badge variant={prefix.isPool ? 'default' : 'outline'}>{prefix.isPool ? 'Yes' : 'No'}</Badge>
              </SummaryRow>
              <SummaryRow label="Role" nullFallback="--">
                {prefix.role}
              </SummaryRow>
              <SummaryRow label="Zone" nullFallback="--">
                {zoneName}
              </SummaryRow>
              <SummaryRow label="Gateway" nullFallback="--">
                {gatewayAddress}
              </SummaryRow>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-border divide-y">
              <SummaryRow label="VRF ID" nullFallback="--">
                {prefix.vrfId}
              </SummaryRow>
              <SummaryRow label="Created" nullFallback="--">
                {new Date(prefix.createdAt).toLocaleDateString()}
              </SummaryRow>
              <SummaryRow label="Updated" nullFallback="--">
                {new Date(prefix.updatedAt).toLocaleDateString()}
              </SummaryRow>
            </div>
          </CardContent>
        </Card>
      </div>

      <PrefixBondParametersCard prefixId={prefixId} bondParameters={prefix.bondParameters} />
      <PrefixVrrpSummaryCard prefixId={prefixId} vrrpVipId={prefix.vrrpVipId} zoneId={prefix.zoneId} />
      <PrefixDhcpSummaryCard prefixId={prefixId} />
    </div>
  );
}
