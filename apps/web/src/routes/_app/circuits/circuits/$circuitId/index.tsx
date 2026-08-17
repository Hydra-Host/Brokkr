import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuits/$circuitId/')({
  component: CircuitOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function CircuitOverview() {
  const { circuitId } = Route.useParams();

  const { data, isPending } = tsr.getCircuit.useQuery({
    queryKey: ['circuit', circuitId],
    queryData: { params: { id: circuitId } },
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

  const circuit = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="CID" value={circuit.cid} />
          <InfoRow label="Status" value={circuit.status} />
          <InfoRow label="Provider ID" value={circuit.providerId} />
          <InfoRow label="Circuit Type ID" value={circuit.circuitTypeId} />
          <InfoRow label="Commit Rate" value={circuit.commitRate} />
          <InfoRow label="Description" value={circuit.description} />
          <InfoRow label="Comments" value={circuit.comments} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={circuit.id} />
          <InfoRow label="Created" value={new Date(circuit.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(circuit.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
