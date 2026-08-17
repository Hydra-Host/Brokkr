import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/circuits/provider-networks/$networkId/')({
  component: ProviderNetworkOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function ProviderNetworkOverview() {
  const { networkId } = Route.useParams();

  const { data, isPending } = tsr.getProviderNetwork.useQuery({
    queryKey: ['provider-network', networkId],
    queryData: { params: { id: networkId } },
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

  const network = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={network.name} />
          <InfoRow label="Provider ID" value={network.providerId} />
          <InfoRow label="Description" value={network.description} />
          <InfoRow label="Comments" value={network.comments} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={network.id} />
          <InfoRow label="Created" value={new Date(network.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(network.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
