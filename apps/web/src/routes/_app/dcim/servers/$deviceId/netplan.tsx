import { DeviceNetplanQuerySchema } from '@repo/api-client';
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/netplan')({
  validateSearch: DeviceNetplanQuerySchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/dcim/servers/$deviceId/networking',
      params,
      search: { tab: 'netplan', phase: search.phase },
      replace: true,
    });
  },
});
