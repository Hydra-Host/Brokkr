import { createFileRoute } from '@tanstack/react-router';

import { ConfigZonesPage } from '@/features/config/zones-page';

export const Route = createFileRoute('/config/zones')({ component: ConfigZonesPage });
