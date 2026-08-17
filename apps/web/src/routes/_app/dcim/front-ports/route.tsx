import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/front-ports')({
  staticData: { breadcrumb: 'Front Ports' },
  component: Outlet,
});
