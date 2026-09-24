import type { Server } from '@repo/api-client';
import type { DiagnosticDevice } from '@repo/domain-ui/components/diagnostic-header-lines';

export type DiagnosticServer = Pick<Server, 'id' | 'name' | 'dcim' | 'status' | 'zoneId' | 'zoneName' | 'networking'>;

export function toDiagnosticDevice(device: DiagnosticServer): DiagnosticDevice {
  return {
    id: device.id,
    displayName: device.dcim?.nickname || device.name,
    zoneId: device.zoneId,
    zoneName: device.zoneName,
    bmcIp: device.networking?.ipmiIp ?? null,
    // a deployment row exists while the discovery os is still installing, so only the status says the deployed os runs
    deployedOs: device.status?.value?.toLowerCase() === 'provisioned',
    status: device.status?.label ?? null,
  };
}
