import type { Decorator } from '@storybook/react-vite';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useMemo, type ComponentType } from 'react';

// TanStack Router memory-router wrapper for stories using ButtonLink,
// useFilters, or useNavigationShortcuts. The story itself is the root route's
// component, so search-param reads and writes go against in-memory history
// instead of the Storybook iframe URL.
function RouterStory({ Story }: { Story: ComponentType }) {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: () => <Story /> });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, [Story]);
  return <RouterProvider router={router} />;
}

export const withRouter: Decorator = (Story) => <RouterStory Story={Story} />;
