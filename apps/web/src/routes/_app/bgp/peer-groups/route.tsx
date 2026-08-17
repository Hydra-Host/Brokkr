import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/bgp/peer-groups')({
  staticData: { breadcrumb: 'Peer Groups' },
  component: Outlet,
});
