import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/sessions/$sessionId/')({
  component: BgpSessionOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function BgpSessionOverview() {
  const { sessionId } = Route.useParams();

  const { data, isPending } = tsr.getBgpSession.useQuery({
    queryKey: ['bgp-session', sessionId],
    queryData: { params: { id: sessionId } },
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

  const session = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={session.name} />
          <InfoRow label="Status" value={session.status} />
          <InfoRow label="Description" value={session.description} />
          <InfoRow label="Device ID" value={session.deviceId} />
          <InfoRow label="Local ASN ID" value={session.localAsnId} />
          <InfoRow label="Remote ASN ID" value={session.remoteAsnId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Routing</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Local Address ID" value={session.localAddressId} />
          <InfoRow label="Remote Address ID" value={session.remoteAddressId} />
          <InfoRow label="Peer Group ID" value={session.peerGroupId} />
          <InfoRow label="Prefix List In ID" value={session.prefixListInId} />
          <InfoRow label="Prefix List Out ID" value={session.prefixListOutId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={session.id} />
          <InfoRow label="Created" value={new Date(session.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(session.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
