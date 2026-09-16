import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { History } from 'lucide-react';
import { JobHistoryTable, useCanViewJobHistory } from '~/components/job-history-table';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/jobs')({
  staticData: { breadcrumb: 'Jobs' },
  component: ServerJobs,
});

function ServerJobs() {
  const device = parentRoute.useLoaderData();
  const displayName = device.dcim?.nickname || device.name;
  const { canView, isPending } = useCanViewJobHistory();

  useDocumentTitle(`${displayName} - Jobs`);

  if (isPending || !canView) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          Job History
        </CardTitle>
        <CardDescription>Lifecycle jobs dispatched for {displayName}.</CardDescription>
      </CardHeader>
      <CardContent>
        <JobHistoryTable deviceId={device.id} tableName={`device-jobs-${device.id}`} />
      </CardContent>
    </Card>
  );
}
