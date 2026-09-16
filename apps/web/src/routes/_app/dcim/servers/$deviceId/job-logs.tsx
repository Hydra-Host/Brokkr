import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, getRouteApi, useNavigate, useSearch } from '@tanstack/react-router';
import { DeviceJobLogsCard } from '~/components/device-job-logs-card';

interface ServerJobLogsSearch {
  job?: string;
}

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/job-logs')({
  staticData: { breadcrumb: 'Job Logs' },
  component: ServerJobLogs,
  validateSearch: (search: Record<string, unknown>): ServerJobLogsSearch => ({
    job: typeof search.job === 'string' ? search.job : undefined,
  }),
});

function ServerJobLogs() {
  const device = parentRoute.useLoaderData();
  const displayName = device.dcim?.nickname || device.name;
  useDocumentTitle(`${displayName} - Job Logs`);

  const { job } = useSearch({ from: '/_app/dcim/servers/$deviceId/job-logs' });
  const navigate = useNavigate({ from: '/dcim/servers/$deviceId/job-logs' });

  const selectJob = (value: string) => {
    void navigate({ search: (previous) => ({ ...previous, job: value }), replace: true });
  };

  return (
    <DeviceJobLogsCard deviceId={device.id} displayName={displayName} requestedJobId={job} onSelectJob={selectJob} />
  );
}
