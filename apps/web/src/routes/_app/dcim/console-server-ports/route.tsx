import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/console-server-ports')({
  staticData: { breadcrumb: 'Console Server Ports' },
  component: Outlet,
});
