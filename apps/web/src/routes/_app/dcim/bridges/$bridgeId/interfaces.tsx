import { createFileRoute, getRouteApi } from '@tanstack/react-router';

import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { DeviceInterfaces } from '~/components/device-interfaces';

const parentRoute = getRouteApi('/_app/dcim/bridges/$bridgeId');

export const Route = createFileRoute('/_app/dcim/bridges/$bridgeId/interfaces')({
  staticData: { breadcrumb: 'Interfaces' },
  component: BridgeInterfaces,
});

function BridgeInterfaces() {
  const bridge = parentRoute.useLoaderData();
  useDocumentTitle(bridge.name ?? 'Bridge');

  return (
    <DeviceInterfaces
      deviceId={bridge.id}
      description="Bridge network interface configuration"
      emptyDescription="No network interfaces are configured for this bridge."
    />
  );
}
