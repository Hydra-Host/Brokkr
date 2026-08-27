import type { NetplanPhase } from '@repo/api-client';
import { NetplanViewer } from '@repo/domain-ui/components/netplan-viewer';
import { tsr } from '~/lib/api';

interface DeviceNetplanContentProps {
  deviceId: string;
  phase: NetplanPhase;
  onPhaseChange: (phase: NetplanPhase) => void;
}

export function DeviceNetplanContent({ deviceId, phase, onPhaseChange }: DeviceNetplanContentProps) {
  const { data, isPending, error } = tsr.getDeviceNetplan.useQuery({
    queryKey: ['device-netplan', deviceId, phase],
    queryData: { params: { deviceId }, query: { phase } },
  });

  const requestError = data && data.status !== 200 ? data : error;
  const yaml = data?.status === 200 ? data.body.yaml : undefined;

  return (
    <NetplanViewer phase={phase} yaml={yaml} isLoading={isPending} error={requestError} onPhaseChange={onPhaseChange} />
  );
}
