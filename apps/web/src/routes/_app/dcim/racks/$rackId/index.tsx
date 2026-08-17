import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/racks/$rackId/')({
  component: RackOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function RackOverview() {
  const { rackId } = Route.useParams();

  const { data, isPending } = tsr.getDcimRack.useQuery({
    queryKey: ['dcim-rack', rackId],
    queryData: { params: { id: rackId } },
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

  const rack = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={rack.name} />
          <InfoRow label="Status" value={rack.status} />
          <InfoRow label="Role" value={rack.role} />
          <InfoRow label="Height (U)" value={rack.heightU} />
          <InfoRow label="Starting Unit" value={rack.startingUnit} />
          <InfoRow label="Serial" value={rack.serial} />
          <InfoRow label="Asset Tag" value={rack.assetTag} />
          <InfoRow label="Description" value={rack.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={rack.id} />
          <InfoRow label="Zone ID" value={rack.zoneId} />
          <InfoRow label="Organization ID" value={rack.organizationId} />
          <InfoRow label="Created" value={new Date(rack.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(rack.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
