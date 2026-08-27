import type { PluginPublicRouteLayout } from '@hydrahost/plugin-sdk';
import { useSession } from '@repo/auth/client';
import { notFound } from '@tanstack/react-router';

import { BootScreen } from '~/components/boot-screen';

import { PluginErrorBoundary } from './plugin-error-boundary';
import { usePluginRegistry } from './plugin-registry-provider';
import { findPublicPluginRoute } from './public-routes';

interface Props {
  pathname: string;
  layout: PluginPublicRouteLayout;
}

export function PublicPluginRouteDispatcher({ pathname, layout }: Props) {
  const registry = usePluginRegistry();
  const { data: session } = useSession();
  const entry = findPublicPluginRoute(registry.publicRoutes, pathname, layout);

  if (!entry) {
    throw notFound();
  }

  const Component = entry.route.component;
  // Public routes are exact-path mounts; deep links use query params.
  const splat = '';

  return (
    <PluginErrorBoundary key={`${entry.pluginId}:${pathname}`} pluginId={entry.pluginId}>
      <Component pluginId={entry.pluginId} splat={splat} LoadingScreen={BootScreen} userEmail={session?.user?.email} />
    </PluginErrorBoundary>
  );
}
