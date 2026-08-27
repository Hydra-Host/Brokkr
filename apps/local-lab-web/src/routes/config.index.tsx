import { createFileRoute } from '@tanstack/react-router';

import { ConfigOverview } from '@/features/config/overview-page';

export const Route = createFileRoute('/config/')({ component: ConfigOverview });
