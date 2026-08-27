import { createFileRoute, useLocation } from '@tanstack/react-router';

import { NotFound } from '~/components/not-found';
import { PublicPluginRouteDispatcher } from '~/plugin-host';

/** Catch-all under the public navbar so plugin `publicRoutes` (`layout: 'navbar'`) stay off the login wall. */
export const Route = createFileRoute('/_navbar-layout/$')({
  component: PublicPluginNavbarSplat,
  notFoundComponent: NotFound,
});

function PublicPluginNavbarSplat() {
  const { pathname } = useLocation();
  return <PublicPluginRouteDispatcher pathname={pathname} layout="navbar" />;
}
