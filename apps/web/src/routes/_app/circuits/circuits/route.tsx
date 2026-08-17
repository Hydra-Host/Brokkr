import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/circuits/circuits')({
  staticData: { breadcrumb: 'Circuits' },
  component: Outlet,
});
