import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/organizations/')({
  component: () => <Navigate to="/organizations/members" />,
});
