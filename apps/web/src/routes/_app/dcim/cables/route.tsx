import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/cables')({
  staticData: { breadcrumb: 'Cables' },
  component: Outlet,
});
