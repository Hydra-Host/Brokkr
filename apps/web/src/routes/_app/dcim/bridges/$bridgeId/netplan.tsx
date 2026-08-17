import { DeviceNetplanQuerySchema, type NetplanPhase } from '@repo/api-client';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute } from '@tanstack/react-router';
import { DeviceNetplanContent } from '~/components/device-netplan-content';

export const Route = createFileRoute('/_app/dcim/bridges/$bridgeId/netplan')({
  validateSearch: DeviceNetplanQuerySchema,
  staticData: { breadcrumb: 'Netplan' },
  component: BridgeNetplanPage,
});

function BridgeNetplanPage() {
  const { bridgeId } = Route.useParams();
  const { phase } = Route.useSearch();
  const navigate = Route.useNavigate();
  useDocumentTitle('Netplan');

  const changePhase = (nextPhase: NetplanPhase) => {
    void navigate({ search: { phase: nextPhase }, replace: true });
  };

  return <DeviceNetplanContent deviceId={bridgeId} phase={phase} onPhaseChange={changePhase} />;
}
