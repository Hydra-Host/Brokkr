import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/account/')({
  component: () => <Navigate to="/account/profile" />,
});
