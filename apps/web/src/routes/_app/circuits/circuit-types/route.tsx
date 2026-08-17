import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/circuits/circuit-types')({
  staticData: { breadcrumb: 'Circuit Types' },
  component: Outlet,
});
