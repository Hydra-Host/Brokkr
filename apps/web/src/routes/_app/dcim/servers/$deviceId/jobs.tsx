import { JobsConsole } from '@repo/domain-ui/components/jobs-console';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { History } from 'lucide-react';
import { useCanViewJobHistory } from '~/components/job-history-table';
import { usePermissions } from '~/hooks/use-permissions';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

interface ServerJobsSearch {
  job?: string;
}

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/jobs')({
  validateSearch: (search: Record<string, unknown>): ServerJobsSearch => ({
    job: typeof search.job === 'string' ? search.job : undefined,
  }),
  staticData: { breadcrumb: 'Jobs' },
  component: ServerJobs,
});

function ServerJobs() {
  const device = parentRoute.useLoaderData();
  const { job } = Route.useSearch();
  const navigate = Route.useNavigate();
  const displayName = device.dcim?.nickname || device.name;
  const { canView, isPending } = useCanViewJobHistory();
  const { can, isLoading } = usePermissions();

  useDocumentTitle(`${displayName} - Jobs`);

  const selectJob = (jobId: string) => {
    // a spread updater keeps the table's pagination and sort params in the url
    void navigate({ search: (previous) => ({ ...previous, job: jobId }), replace: true });
  };

  if (isPending || isLoading) return null;
  if (!canView && !can('job-log', 'access')) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5" />
          Jobs
        </CardTitle>
        <CardDescription>Lifecycle jobs dispatched for {displayName}, with their steps and logs.</CardDescription>
      </CardHeader>
      <CardContent>
        <JobsConsole deviceId={device.id} requestedJobId={job} onSelectJob={selectJob} />
      </CardContent>
    </Card>
  );
}
