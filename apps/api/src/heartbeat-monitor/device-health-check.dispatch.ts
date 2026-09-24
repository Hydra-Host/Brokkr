import { DeviceRole, type Prisma, ServerLifecycleStatus } from '@repo/database';
import { DeviceSpecHelper } from '@repo/device-domain';
import {
  bmcSecretDispatchFields,
  type DeviceContext,
  deviceContextSelect,
} from 'src/brokkr-bridge/device-context.service';

export const healthCheckDeviceSelect = {
  ...deviceContextSelect,
  networkType: true,
  interfaces: {
    where: { deletedAt: null },
    include: {
      ipAddresses: {
        where: { deletedAt: null },
        include: { natOutside: { where: { deletedAt: null }, select: { address: true } } },
      },
    },
  },
} satisfies Prisma.DeviceSelect;

export type HealthCheckDevice = Prisma.DeviceGetPayload<{ select: typeof healthCheckDeviceSelect }>;

// canonical role for new rows is Server; Baremetal is the legacy import value
export const HEALTH_CHECK_ROLES: DeviceRole[] = [DeviceRole.Baremetal, DeviceRole.Server];

export const HEALTH_CHECK_ELIGIBLE_WHERE = {
  deletedAt: null,
  NOT: { server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } },
  role: { in: HEALTH_CHECK_ROLES },
  interfaces: { some: { mgmtOnly: true, deletedAt: null, ipAddresses: { some: { deletedAt: null } } } },
} satisfies Prisma.DeviceWhereInput;

export function buildHealthCheckDispatch(device: HealthCheckDevice, ctx: DeviceContext) {
  return {
    payload: {
      device_id: device.id,
      bmc_ip: ctx.bmcIp,
      primary_ip: DeviceSpecHelper.ipv4({ networkType: device.networkType, interfaces: device.interfaces }) || null,
      ...bmcSecretDispatchFields(ctx.bmcSecret),
    },
    options: {
      removeOnComplete: { age: 60 },
      removeOnFail: { age: 600 },
      coalesceKey: `health-cron-${device.id}`,
    },
  };
}
