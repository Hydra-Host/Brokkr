import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/vlan-groups/$vlanGroupId/')({
  component: VlanGroupOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function VlanGroupOverview() {
  const { vlanGroupId } = Route.useParams();

  const { data, isPending } = tsr.getVlanGroup.useQuery({
    queryKey: ['vlan-group', vlanGroupId],
    queryData: { params: { id: vlanGroupId } },
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

  const vlanGroup = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={vlanGroup.name} />
          <InfoRow label="Description" value={vlanGroup.description} />
          <InfoRow label="Min VID" value={vlanGroup.minVid} />
          <InfoRow label="Max VID" value={vlanGroup.maxVid} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Zone ID" value={vlanGroup.zoneId} />
          <InfoRow label="Created" value={new Date(vlanGroup.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(vlanGroup.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
