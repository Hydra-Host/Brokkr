import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/datacenters/')({
  beforeLoad: () => {
    throw redirect({ href: '/dcim/zones', replace: true });
  },
});
