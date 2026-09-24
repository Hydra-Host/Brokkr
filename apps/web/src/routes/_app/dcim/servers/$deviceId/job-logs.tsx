import { createFileRoute, redirect } from '@tanstack/react-router';

interface ServerJobLogsSearch {
  job?: string;
}

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/job-logs')({
  validateSearch: (search: Record<string, unknown>): ServerJobLogsSearch => ({
    job: typeof search.job === 'string' ? search.job : undefined,
  }),
  beforeLoad: ({ params }) => {
    // search: true carries ?job= through to the jobs console
    throw redirect({ to: '/dcim/servers/$deviceId/jobs', params, search: true, replace: true });
  },
});
