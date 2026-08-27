import { createFileRoute } from '@tanstack/react-router';

import { ConfigAdvancedPage } from '@/features/config/advanced-page';

export const Route = createFileRoute('/config/advanced')({ component: ConfigAdvancedPage });
