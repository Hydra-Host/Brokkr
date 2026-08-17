import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/console-ports')({
  staticData: { breadcrumb: 'Console Ports' },
  component: Outlet,
});
