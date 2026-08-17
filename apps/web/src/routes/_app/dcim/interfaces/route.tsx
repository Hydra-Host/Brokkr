import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/interfaces')({
  staticData: { breadcrumb: 'Interfaces' },
  component: Outlet,
});
