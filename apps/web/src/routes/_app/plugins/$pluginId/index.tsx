import { createFileRoute } from '@tanstack/react-router';

import { PluginRouteDispatcher } from '~/plugin-host';

export const Route = createFileRoute('/_app/plugins/$pluginId/')({
  component: PluginRootRoute,
});

function PluginRootRoute() {
  const { pluginId } = Route.useParams();
  return <PluginRouteDispatcher pluginId={pluginId} splat="" />;
}
