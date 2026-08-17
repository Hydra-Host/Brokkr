import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/bgp/prefix-list-rules')({
  staticData: { breadcrumb: 'Prefix List Rules' },
  component: Outlet,
});
