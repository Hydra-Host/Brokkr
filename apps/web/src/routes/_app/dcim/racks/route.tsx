import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/racks')({
  staticData: { breadcrumb: 'Racks' },
  component: Outlet,
});
