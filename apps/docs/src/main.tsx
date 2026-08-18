import { configureUiBrand } from '@repo/ui/lib/brand';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';

import './index.css';
import { BRAND_NAME, HELPDESK_URL } from './lib/branding';
import { routeTree } from './routeTree.gen';

configureUiBrand({ name: BRAND_NAME, helpdeskUrl: HELPDESK_URL });

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
