import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/decommission')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/dcim/servers/$deviceId/settings', params, search: { tab: 'decommission' }, replace: true });
  },
});
