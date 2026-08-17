import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/circuits/provider-networks')({
  staticData: { breadcrumb: 'Provider Networks' },
  component: Outlet,
});
