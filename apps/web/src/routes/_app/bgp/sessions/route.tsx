import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/bgp/sessions')({
  staticData: { breadcrumb: 'BGP Sessions' },
  component: Outlet,
});
