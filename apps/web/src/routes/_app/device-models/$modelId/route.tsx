import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/device-models/$modelId')({
  staticData: { breadcrumb: 'Device Model Detail' },
  component: DeviceModelLayout,
});

function DeviceModelLayout() {
  const { modelId } = Route.useParams();

  const { data, isPending } = tsr.getDeviceModel.useQuery({
    queryKey: ['device-model', modelId],
    queryData: { params: { id: modelId } },
  });

  useDocumentTitle(data?.status === 200 ? `${data.body.manufacturer} ${data.body.model}` : 'Device Model Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Device model not found.</p>;
  }

  const dm = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">
            {dm.manufacturer} {dm.model}
          </span>
          {dm.formFactor && <Badge variant="outline">{dm.formFactor}</Badge>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/device-models/$modelId/edit" params={{ modelId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/device-models/$modelId/delete" params={{ modelId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
