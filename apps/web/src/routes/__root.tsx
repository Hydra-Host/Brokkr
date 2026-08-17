import { Toaster } from '@repo/ui/components/sonner';
import { ThemeProvider } from '@repo/ui/theme-provider';
import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { NotFound } from '~/components/not-found';
import { RouteError } from '~/components/route-error';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <ThemeProvider>
      <TanStackDevtools />
      <Outlet />
      <Toaster position="bottom-right" richColors closeButton />
    </ThemeProvider>
  );
}
