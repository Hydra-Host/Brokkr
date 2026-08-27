import { setDocumentTitleSuffix } from '@repo/ui/hooks/use-document-title';
import { configureUiBrand } from '@repo/ui/lib/brand';
import { unwrapErrorMessage } from '@repo/utils';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { toast } from 'sonner';

import './brokkr.css';
import { BootScreen } from './components/boot-screen';
import { NotFound } from './components/not-found';
import { tsr } from './lib/api';
import { BRAND_NAME, HELPDESK_URL } from './lib/branding';
import { PluginRegistryProvider } from './plugin-host';
import reportWebVitals from './reportWebVitals';
import { routeTree } from './routeTree.gen';

setDocumentTitleSuffix(BRAND_NAME);
configureUiBrand({ name: BRAND_NAME, helpdeskUrl: HELPDESK_URL });

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      silent?: boolean;
      successMessage?: string;
      errorMessage?: string;
    };
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return;

      if (mutation.meta?.successMessage) {
        toast.success(mutation.meta.successMessage);
      }
    },
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return;

      toast.error(mutation.meta?.errorMessage ?? unwrapErrorMessage(error, 'Something went wrong'));
    },
  }),
});

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultViewTransition: true,
  scrollRestoration: true,
  defaultStructuralSharing: true,
  defaultPreloadGcTime: 0,
  defaultPendingComponent: BootScreen,
  defaultPendingMs: 200,
  defaultNotFoundComponent: NotFound,
  context: {
    queryClient,
  },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    breadcrumb?: string | ((loaderData: unknown) => string);
    description?: string | ((loaderData: unknown) => string);
    hideZoneHeader?: boolean;
  }
}

const rootElement = document.getElementById('root');
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <tsr.ReactQueryProvider>
          <PluginRegistryProvider fallback={<BootScreen />}>
            <RouterProvider router={router} />
          </PluginRegistryProvider>
        </tsr.ReactQueryProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

reportWebVitals(router);
