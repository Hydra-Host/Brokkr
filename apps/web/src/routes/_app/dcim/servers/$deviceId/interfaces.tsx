import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/interfaces')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/dcim/servers/$deviceId/networking', params, search: { tab: 'interfaces' }, replace: true });
  },
});
