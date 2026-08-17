import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/circuit-terminations/$terminationId/')({
  component: CircuitTerminationOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function CircuitTerminationOverview() {
  const { terminationId } = Route.useParams();

  const { data, isPending } = tsr.getCircuitTermination.useQuery({
    queryKey: ['circuit-termination', terminationId],
    queryData: { params: { id: terminationId } },
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

  const termination = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Term Side" value={termination.termSide} />
          <InfoRow label="Circuit ID" value={termination.circuitId} />
          <InfoRow label="Port Speed" value={termination.portSpeed} />
          <InfoRow label="Upstream Speed" value={termination.upstreamSpeed} />
          <InfoRow label="Cross-Connect ID" value={termination.xconnectId} />
          <InfoRow label="Zone ID" value={termination.zoneId} />
          <InfoRow label="Description" value={termination.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={termination.id} />
          <InfoRow label="Created" value={new Date(termination.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(termination.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
