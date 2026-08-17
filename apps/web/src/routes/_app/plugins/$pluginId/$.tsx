import { createFileRoute } from '@tanstack/react-router';

import { PluginRouteDispatcher } from '~/plugin-host';

export const Route = createFileRoute('/_app/plugins/$pluginId/$')({
  component: PluginSplatRoute,
});

function PluginSplatRoute() {
  const { pluginId, _splat } = Route.useParams();
  return <PluginRouteDispatcher pluginId={pluginId} splat={_splat ?? ''} />;
}
