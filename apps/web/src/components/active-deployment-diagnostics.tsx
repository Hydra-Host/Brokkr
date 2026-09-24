import { DeviceDiagnosticsCard } from '~/components/device-diagnostics-card';
import { tsr } from '~/lib/api';

export function ActiveDeploymentDiagnostics({ deploymentId }: { deploymentId: string }) {
  const query = tsr.getDeploymentById.useQuery({
    queryKey: ['deployment', deploymentId],
    queryData: { params: { id: deploymentId } },
  });
  const deployment = query.data?.status === 200 ? query.data.body : null;
  if (deployment === null || !deployment.deviceDiagnostics || deployment.deviceDiagnostics.length === 0) return null;
  return <DeviceDiagnosticsCard diagnostics={deployment.deviceDiagnostics} />;
}
