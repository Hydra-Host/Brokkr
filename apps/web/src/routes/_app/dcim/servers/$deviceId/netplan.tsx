import { DeviceNetplanQuerySchema, type NetplanPhase } from '@repo/api-client';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute } from '@tanstack/react-router';
import { DeviceNetplanContent } from '~/components/device-netplan-content';

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/netplan')({
  validateSearch: DeviceNetplanQuerySchema,
  staticData: { breadcrumb: 'Netplan' },
  component: ServerNetplanPage,
});

function ServerNetplanPage() {
  const { deviceId } = Route.useParams();
  const { phase } = Route.useSearch();
  const navigate = Route.useNavigate();
  useDocumentTitle('Netplan');

  const changePhase = (nextPhase: NetplanPhase) => {
    void navigate({ search: { phase: nextPhase }, replace: true });
  };

  return <DeviceNetplanContent deviceId={deviceId} phase={phase} onPhaseChange={changePhase} />;
}
