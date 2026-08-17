import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/ipam/roles/$roleId/')({
  component: IpamRoleOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function IpamRoleOverview() {
  const { roleId } = Route.useParams();

  const { data, isPending } = tsr.getIpamRole.useQuery({
    queryKey: ['ipam-role', roleId],
    queryData: { params: { id: roleId } },
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

  const role = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={role.name} />
          <InfoRow label="Slug" value={<span className="font-mono text-xs">{role.slug}</span>} />
          <InfoRow label="Weight" value={role.weight} />
          <InfoRow label="Description" value={role.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Created" value={new Date(role.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(role.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
