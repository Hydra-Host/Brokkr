import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/device-models/$modelId/')({
  component: DeviceModelOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function DeviceModelOverview() {
  const { modelId } = Route.useParams();

  const { data, isPending } = tsr.getDeviceModel.useQuery({
    queryKey: ['device-model', modelId],
    queryData: { params: { id: modelId } },
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

  if (!data || data.status !== 200) return null;

  const dm = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Manufacturer" value={dm.manufacturer} />
          <InfoRow label="Model" value={dm.model} />
          <InfoRow label="Form Factor" value={dm.formFactor} />
          <InfoRow label="Description" value={dm.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Specifications</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Full Depth" value={<Badge variant="outline">{dm.isFullDepth ? 'Yes' : 'No'}</Badge>} />
          <InfoRow label="Height" value={dm.heightU != null ? `${dm.heightU}U` : null} />
          <InfoRow label="Max Power" value={dm.maxPowerW != null ? `${dm.maxPowerW}W` : null} />
          <InfoRow label="Created" value={new Date(dm.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(dm.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
