import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/rack-roles')({
  staticData: { breadcrumb: 'Rack Roles' },
  component: Outlet,
});
