import { createFileRoute, getRouteApi } from '@tanstack/react-router';

import type { Server } from '@repo/api-client';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { DeviceInterfaces } from '~/components/device-interfaces';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/interfaces')({
  staticData: { breadcrumb: 'Interfaces' },
  component: ServerInterfaces,
});

function ServerInterfaces() {
  const device = parentRoute.useLoaderData() as Server;
  useDocumentTitle(device.dcim?.nickname || device.name);

  return (
    <DeviceInterfaces
      deviceId={device.id}
      description="Server network interface configuration"
      emptyDescription="No network interfaces are configured for this server."
    />
  );
}
