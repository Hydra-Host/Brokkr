import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/power-ports')({
  staticData: { breadcrumb: 'Power Ports' },
  component: Outlet,
});
