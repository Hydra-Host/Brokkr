import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from '@/components/ui/theme';
import { tsr } from '@/lib/api';
import { isClientErrorResponse } from '@/lib/errors';
import { routeTree } from './routeTree.gen';

import 'driver.js/dist/driver.css';
import './brokkr.css';
import './styles/tour.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // a thrown 4xx is deterministic, so retrying it only delays the error by three backoffs.
      retry: (count, error) => !isClientErrorResponse(error) && count < 1,
      staleTime: 15_000,
      // the live views drive their own refetchInterval; a focus refetch only clobbers the config forms.
      refetchOnWindowFocus: false,
    },
  },
});
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <tsr.ReactQueryProvider>
          <RouterProvider router={router} />
        </tsr.ReactQueryProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
