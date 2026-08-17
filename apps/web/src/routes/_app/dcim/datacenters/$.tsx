import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/dcim/datacenters/$')({
  beforeLoad: ({ params }) => {
    throw redirect({ href: `/dcim/zones/${params._splat ?? ''}`, replace: true });
  },
});
