import { DeviceStatus, ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';

// Status slugs are Brokkr's interchange format — also the on-wire device_record contract the bridge parses.

export const TRANSITIONAL_SERVER_POWER_STATUSES = [
  ServerPowerStatus.PoweringOn,
  ServerPowerStatus.PoweringOff,
  ServerPowerStatus.Rebooting,
] as const;

const STATUS_SLUG_TO_SERVER_LIFECYCLE: Record<string, ServerLifecycleStatus> = {
  inventory: ServerLifecycleStatus.INVENTORY,
  planned: ServerLifecycleStatus.INVENTORY,
  provisioning: ServerLifecycleStatus.PROVISIONING,
  staged: ServerLifecycleStatus.PROVISIONING,
  provisioned: ServerLifecycleStatus.PROVISIONED,
  active: ServerLifecycleStatus.PROVISIONED,
  offline: ServerLifecycleStatus.OFFLINE,
  maintenance: ServerLifecycleStatus.OFFLINE,
  failed: ServerLifecycleStatus.FAILED,
  deprovisioning: ServerLifecycleStatus.DEPROVISIONING,
};

const SERVER_LIFECYCLE_TO_SLUG: Record<ServerLifecycleStatus, string> = {
  [ServerLifecycleStatus.INVENTORY]: 'inventory',
  [ServerLifecycleStatus.PROVISIONING]: 'provisioning',
  [ServerLifecycleStatus.PROVISIONED]: 'provisioned',
  [ServerLifecycleStatus.OFFLINE]: 'offline',
  [ServerLifecycleStatus.FAILED]: 'failed',
  [ServerLifecycleStatus.DEPROVISIONING]: 'deprovisioning',
};

const DEVICE_STATUS_TO_SLUG: Record<DeviceStatus, string> = {
  [DeviceStatus.PLANNED]: 'planned',
  [DeviceStatus.STAGED]: 'staged',
  [DeviceStatus.ACTIVE]: 'active',
  [DeviceStatus.MAINTENANCE]: 'active',
};

export function statusSlugToServerLifecycle(status: string): ServerLifecycleStatus {
  const mapped = STATUS_SLUG_TO_SERVER_LIFECYCLE[status.toLowerCase()];
  if (!mapped) {
    throw new Error(`Unknown server lifecycle status: ${status}`);
  }
  return mapped;
}

export function deviceStatusToSlug(status: DeviceStatus): string {
  return DEVICE_STATUS_TO_SLUG[status];
}

export function serverLifecycleToSlug(status: ServerLifecycleStatus): string {
  return SERVER_LIFECYCLE_TO_SLUG[status];
}

export function powerWordToServerPowerStatus(raw: unknown): ServerPowerStatus | null {
  switch (raw) {
    case 'Running':
      return ServerPowerStatus.On;
    case 'Powered Off':
      return ServerPowerStatus.Off;
    case 'Starting':
      return ServerPowerStatus.PoweringOn;
    case 'Shutting Down':
      return ServerPowerStatus.PoweringOff;
    case 'Rebooting':
      return ServerPowerStatus.Rebooting;
    default:
      return null;
  }
}

export function serverPowerStatusToLegacy(ps: ServerPowerStatus | null | undefined): string | null {
  switch (ps) {
    case ServerPowerStatus.On:
      return 'Running';
    case ServerPowerStatus.Off:
      return 'Powered Off';
    case ServerPowerStatus.PoweringOn:
      return 'Starting';
    case ServerPowerStatus.PoweringOff:
      return 'Shutting Down';
    case ServerPowerStatus.Rebooting:
      return 'Rebooting';
    default:
      return null;
  }
}
