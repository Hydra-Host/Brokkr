import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/circuits/circuit-terminations')({
  staticData: { breadcrumb: 'Circuit Terminations' },
  component: Outlet,
});
