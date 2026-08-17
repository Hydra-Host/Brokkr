import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/console-ports/$portId/')({
  component: ConsolePortOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function ConsolePortOverview() {
  const { portId } = Route.useParams();

  const { data, isPending } = tsr.getDcimConsolePort.useQuery({
    queryKey: ['dcim-console-port', portId],
    queryData: { params: { id: portId } },
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

  const port = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={port.name} />
          <InfoRow label="Type" value={port.type} />
          <InfoRow label="Speed" value={port.speed} />
          <InfoRow label="Description" value={port.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="ID" value={port.id} />
          <InfoRow label="Device ID" value={port.deviceId} />
          <InfoRow label="Created" value={new Date(port.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(port.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
