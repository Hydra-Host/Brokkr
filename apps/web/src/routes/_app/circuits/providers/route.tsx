import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/circuits/providers')({
  staticData: { breadcrumb: 'Providers' },
  component: Outlet,
});
