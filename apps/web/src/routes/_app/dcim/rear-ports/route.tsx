import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/rear-ports')({
  staticData: { breadcrumb: 'Rear Ports' },
  component: Outlet,
});
