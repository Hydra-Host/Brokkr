import { Device, Organization, ServerLifecycleStatus } from '@repo/database';

export type DeviceAggregate = Device & {
  supplier: Organization;
  server: { lifecycleStatus: ServerLifecycleStatus } | null;
};
