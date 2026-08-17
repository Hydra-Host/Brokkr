import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/cdus/$deviceId/')({
  component: CduOverview,
});

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function CduOverview() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getCduById.useQuery({
    queryKey: ['cdu', deviceId],
    queryData: { params: { deviceId } },
  });

  if (isPending) {
    return (
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
    );
  }

  if (!data || data.status !== 200) {
    return null;
  }

  const cdu = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={cdu.name} />
          <InfoRow label="Nickname" value={cdu.nickname} />
          <InfoRow label="Status" value={cdu.status} />
          <InfoRow label="Device ID" value={<span className="font-mono text-xs">{cdu.deviceId}</span>} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cooling &amp; Specs</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow
            label="Power"
            value={
              cdu.powerStatus ? (
                <Badge variant={cdu.powerStatus === 'On' ? 'default' : 'outline'}>{cdu.powerStatus}</Badge>
              ) : null
            }
          />
          <InfoRow label="Coolant" value={cdu.coolantType} />
          <InfoRow label="Flow rate (L/min)" value={cdu.ratedFlowRateLpm} />
          <InfoRow label="Thermal capacity (kW)" value={cdu.ratedThermalCapacityKw} />
          <InfoRow label="Airflow" value={cdu.airflow} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location &amp; Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Data center" value={cdu.zoneName} />
          <InfoRow label="Supplier" value={cdu.supplierName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(cdu.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(cdu.updatedAt).toLocaleDateString()} />
          <InfoRow label="Decommissioned" value={cdu.deletedAt ? new Date(cdu.deletedAt).toLocaleDateString() : null} />
        </CardContent>
      </Card>
    </div>
  );
}
