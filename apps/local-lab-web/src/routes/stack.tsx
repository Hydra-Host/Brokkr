import { createFileRoute } from '@tanstack/react-router';

import { StackPage } from '@/features/stack/stack-page';
import { validateStackSearch } from '@/lib/stack-search';

export const Route = createFileRoute('/stack')({ component: StackPage, validateSearch: validateStackSearch });
