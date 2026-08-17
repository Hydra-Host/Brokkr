import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/not-found';

export const Route = createFileRoute('/_app/$')({
  component: NotFound,
  staticData: { breadcrumb: 'Page Not Found' },
});
