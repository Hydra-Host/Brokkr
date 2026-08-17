import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/power-outlets')({
  staticData: { breadcrumb: 'Power Outlets' },
  component: Outlet,
});
