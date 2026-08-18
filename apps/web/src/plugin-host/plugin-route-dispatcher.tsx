import { notFound } from '@tanstack/react-router';

import { BootScreen } from '~/components/boot-screen';

import { PluginErrorBoundary } from './plugin-error-boundary';
import { usePluginRegistry } from './plugin-registry-provider';

interface Props {
  pluginId: string;
  splat: string;
}

export function PluginRouteDispatcher({ pluginId, splat }: Props) {
  const registry = usePluginRegistry();
  const entry = registry.routes.get(pluginId);

  if (!entry) {
    throw notFound();
  }

  const Component = entry.route.component;
  return (
    <PluginErrorBoundary key={`${pluginId}:${splat}`} pluginId={pluginId}>
      <Component pluginId={pluginId} splat={splat} LoadingScreen={BootScreen} />
    </PluginErrorBoundary>
  );
}
