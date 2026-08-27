import { createFileRoute } from '@tanstack/react-router';

import { ConfigFleetPage } from '@/features/config/fleet-page';

export const Route = createFileRoute('/config/fleet')({
  component: ConfigFleetPage,
  validateSearch: (search: Record<string, unknown>): { zone?: string } =>
    typeof search.zone === 'string' ? { zone: search.zone } : {},
});
