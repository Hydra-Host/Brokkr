import { createFileRoute } from '@tanstack/react-router';

import { ConfigStackPage } from '@/features/config/stack-page';

export const Route = createFileRoute('/config/stack')({ component: ConfigStackPage });
