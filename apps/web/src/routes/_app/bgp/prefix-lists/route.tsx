import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/bgp/prefix-lists')({
  staticData: { breadcrumb: 'Prefix Lists' },
  component: Outlet,
});
