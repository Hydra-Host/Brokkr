import { createFileRoute, redirect } from '@tanstack/react-router';

/** Bookmark shim for the pre-split editor. Drop it after a release. */
export const Route = createFileRoute('/settings')({
  beforeLoad: () => {
    throw redirect({ to: '/config/stack', replace: true });
  },
});
