import { useSession } from '@repo/auth/client';
import { notFound, useLocation } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';

import { BootScreen } from '~/components/boot-screen';

import { PluginErrorBoundary } from './plugin-error-boundary';
import { usePluginRegistry } from './plugin-registry-provider';
import { publicRedirectFromPluginAppMount } from './public-routes';

interface Props {
  pluginId: string;
  splat: string;
}

export function PluginRouteDispatcher({ pluginId, splat }: Props) {
  const registry = usePluginRegistry();
  const { data: session } = useSession();
  const location = useLocation();
  const publicHref = publicRedirectFromPluginAppMount(location.pathname, location.searchStr, registry.publicRoutes);

  useLayoutEffect(() => {
    if (publicHref) window.location.replace(publicHref);
  }, [publicHref]);

  if (publicHref) {
    return null;
  }

  const entry = registry.routes.get(pluginId);

  if (!entry) {
    throw notFound();
  }

  const Component = entry.route.component;
  return (
    <PluginErrorBoundary key={`${pluginId}:${splat}`} pluginId={pluginId}>
      <Component pluginId={pluginId} splat={splat} LoadingScreen={BootScreen} userEmail={session?.user?.email} />
    </PluginErrorBoundary>
  );
}
