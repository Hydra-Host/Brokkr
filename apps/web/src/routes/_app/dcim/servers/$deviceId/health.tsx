import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/health')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/dcim/servers/$deviceId/diagnostics', params, replace: true });
  },
});
