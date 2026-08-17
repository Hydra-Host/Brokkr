import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/cables/$cableId/')({
  component: CableOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function CableOverview() {
  const { cableId } = Route.useParams();

  const { data, isPending } = tsr.getDcimCable.useQuery({
    queryKey: ['dcim-cable', cableId],
    queryData: { params: { id: cableId } },
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

  const cable = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Label" value={cable.label} />
          <InfoRow label="Type" value={cable.type} />
          <InfoRow label="Status" value={cable.status} />
          <InfoRow
            label="Color"
            value={
              cable.color ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: cable.color }} />
                  <span className="font-mono text-xs">{cable.color}</span>
                </div>
              ) : null
            }
          />
          <InfoRow label="Length" value={cable.length} />
          <InfoRow label="Length Unit" value={cable.lengthUnit} />
          <InfoRow label="Description" value={cable.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={cable.id} />
          <InfoRow label="Created" value={new Date(cable.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(cable.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
