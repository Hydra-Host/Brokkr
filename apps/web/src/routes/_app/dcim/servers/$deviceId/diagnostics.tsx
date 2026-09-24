import { BootDiagnostics } from '@repo/domain-ui/components/boot-diagnostics';
import { HealthDiagnostics } from '@repo/domain-ui/components/health-diagnostics';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { toDiagnosticDevice } from './-header-lines';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/diagnostics')({
  staticData: { breadcrumb: 'Diagnostics' },
  component: ServerDiagnostics,
});

function ServerDiagnostics() {
  const device = toDiagnosticDevice(parentRoute.useLoaderData());
  useDocumentTitle(`${device.displayName} - Diagnostics`);

  return (
    <div className="space-y-6">
      <BootDiagnostics device={device} />
      <HealthDiagnostics device={device} />
    </div>
  );
}
