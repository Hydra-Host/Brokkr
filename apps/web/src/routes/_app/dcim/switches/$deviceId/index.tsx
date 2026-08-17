import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/switches/$deviceId/')({
  component: SwitchOverview,
});

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function SwitchOverview() {
  const { deviceId } = Route.useParams();

  const { data, isPending } = tsr.getSwitchById.useQuery({
    queryKey: ['switch', deviceId],
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

  const sw = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={sw.name} />
          <InfoRow label="Nickname" value={sw.nickname} />
          <InfoRow label="Status" value={sw.status} />
          <InfoRow label="Device ID" value={<span className="font-mono text-xs">{sw.deviceId}</span>} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fabric &amp; Specs</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow
            label="Power"
            value={
              sw.powerStatus ? (
                <Badge variant={sw.powerStatus === 'On' ? 'default' : 'outline'}>{sw.powerStatus}</Badge>
              ) : null
            }
          />
          <InfoRow label="Role" value={sw.switchRole} />
          <InfoRow label="Fabric" value={sw.fabric} />
          <InfoRow label="Port count" value={sw.portCount} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Location &amp; Owner</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Data center" value={sw.zoneName} />
          <InfoRow label="Supplier" value={sw.supplierName} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(sw.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(sw.updatedAt).toLocaleDateString()} />
          <InfoRow label="Decommissioned" value={sw.deletedAt ? new Date(sw.deletedAt).toLocaleDateString() : null} />
        </CardContent>
      </Card>
    </div>
  );
}
