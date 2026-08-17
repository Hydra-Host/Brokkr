import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/tags/$tagId/')({
  component: TagOverview,
});

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border-dim flex justify-between border-b py-1.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value ?? <span className="text-muted-foreground">--</span>}</span>
    </div>
  );
}

function TagOverview() {
  const { tagId } = Route.useParams();

  const { data, isPending } = tsr.getTag.useQuery({
    queryKey: ['tag', tagId],
    queryData: { params: { id: tagId } },
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

  const tag = data.body;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Name" value={tag.name} />
          <InfoRow
            label="Color"
            value={
              tag.color ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border" style={{ backgroundColor: tag.color }} />
                  <span className="font-mono text-xs">{tag.color}</span>
                </div>
              ) : null
            }
          />
          <InfoRow label="Description" value={tag.description} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <InfoRow label="Organization ID" value={tag.organizationId} />
          <InfoRow label="Created" value={new Date(tag.createdAt).toLocaleDateString()} />
          <InfoRow label="Updated" value={new Date(tag.updatedAt).toLocaleDateString()} />
        </CardContent>
      </Card>
    </div>
  );
}
