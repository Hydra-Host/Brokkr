import {
  Deployment,
  DeviceRole,
  DeviceTestRun,
  DeviceTestStatus,
  Organization,
  Reservation,
  ReservationInvite,
  ServerLifecycleStatus,
  ServersInReservationInvite,
  TeeCapability,
} from '@repo/database';
import { hardwareEligibleLayerSlugs, LAYER_SLUGS } from '@repo/layers';
import {
  getBillingFrequencyHours,
  HOURS_IN_MONTH,
  HOURS_IN_WEEK,
  isRecord,
  mapStatusToDeploymentStatus,
} from '@repo/utils';
import { DeviceSpecColumns, DeviceSpecHelper } from './device-spec.helper';

type PriceTier = {
  perGpu: number | null;
  perCpu: number | null;
  total: number | null;
};

type StorageLayoutDiskGroup = {
  config: string;
  file_system: string;
  group: string;
  mountpoint: string;
};

type StorageLayoutConfig = {
  disks: Array<{ wwn?: string | null; name: string; serial?: string | null }>;
  disk_type: string;
  capabilities: string[];
  num_disks: number;
  size_per_disk: number;
  disk_group_name: string;
  file_systems?: string[];
};

type StorageLayouts = {
  configs: StorageLayoutConfig[];
  default: {
    os_disks_group?: StorageLayoutDiskGroup | null;
    data_disks_groups?: StorageLayoutDiskGroup[] | null;
    cold_storage_disks_groups?: StorageLayoutDiskGroup[] | null;
  };
};

export type ReservationWithInvite = Reservation & {
  reservationInvite?: ReservationInvite | null;
};

export type DeploymentWithReservation = Deployment & {
  reservation?: ReservationWithInvite;
  deployer?: { email?: string; id?: string };
  customer?: Organization;
};

export type InviteWithOrg = ReservationInvite & {
  inviteeOrganization: Organization | null;
};

export type ServerSpecsInput = Partial<DeviceSpecColumns> & {
  deviceTestRuns?: DeviceTestRun[];
  gpuCount?: number | null;
  cpuPhysicalCount?: number | null;
  hourlyPrice?: unknown;
  floorHourlyPrice?: unknown;
  teeEnabled?: boolean | null;
  server?: {
    storageLayouts?: unknown;
    teeEnabled?: boolean | null;
    teeCapable?: TeeCapability | null;
    lifecycleStatus?: ServerLifecycleStatus | null;
  } | null;
};

export class ServerSpecHelper extends DeviceSpecHelper {
  static pricing(device: ServerSpecsInput) {
    const hourlyNum = device.hourlyPrice ? Number(device.hourlyPrice.toString()) : null;
    const floorHourlyNum = device.floorHourlyPrice ? Number(device.floorHourlyPrice.toString()) : null;
    const gpuCount = device.gpuCount ?? 0;
    const cpuCount = device.cpuPhysicalCount ?? 0;

    const hourlyPerGpu = gpuCount && hourlyNum ? hourlyNum / gpuCount : null;
    const hourlyPerCpu = cpuCount && hourlyNum ? hourlyNum / cpuCount : null;
    const floorPerGpu = gpuCount && floorHourlyNum ? floorHourlyNum / gpuCount : null;
    const floorPerCpu = cpuCount && floorHourlyNum ? floorHourlyNum / cpuCount : null;

    return {
      onDemand: {
        perHour: { perGpu: hourlyPerGpu, perCpu: hourlyPerCpu, total: hourlyNum } as PriceTier,
        perWeek: ServerSpecHelper.multiplyTier(hourlyPerGpu, hourlyPerCpu, hourlyNum, HOURS_IN_WEEK),
        perMonth: ServerSpecHelper.multiplyTier(hourlyPerGpu, hourlyPerCpu, hourlyNum, HOURS_IN_MONTH),
      },
      interruptible: {
        perHour: { perGpu: floorPerGpu, perCpu: floorPerCpu, total: floorHourlyNum } as PriceTier,
        perWeek: ServerSpecHelper.multiplyTier(floorPerGpu, floorPerCpu, floorHourlyNum, HOURS_IN_WEEK),
        perMonth: ServerSpecHelper.multiplyTier(floorPerGpu, floorPerCpu, floorHourlyNum, HOURS_IN_MONTH),
      },
    };
  }

  private static multiplyTier(
    perGpu: number | null,
    perCpu: number | null,
    total: number | null,
    hours: number,
  ): PriceTier {
    return {
      perGpu: perGpu ? Math.round(perGpu * hours) : null,
      perCpu: perCpu ? Math.round(perCpu * hours) : null,
      total: total ? Math.round(total * hours) : null,
    };
  }

  static isHealthy(device: ServerSpecsInput): boolean | null {
    if (!device.deviceTestRuns) return null;
    const latest = device.deviceTestRuns[0];
    if (!latest) return null;
    if (latest.status !== DeviceTestStatus.Completed || !latest.testPassed) return false;
    return true;
  }

  static status(device: ServerSpecsInput, activeDeployment?: Deployment | null): string {
    if (device.role === DeviceRole.OffMarketplaceHost) {
      return 'Off Market';
    }

    const statusStr = (device.server?.lifecycleStatus ?? device.status ?? 'active').toString().toLowerCase();

    if (activeDeployment) {
      return mapStatusToDeploymentStatus(statusStr);
    }

    return statusStr;
  }

  static teeEnabled(device: ServerSpecsInput): boolean {
    return device.server?.teeEnabled ?? false;
  }

  static teeCapable(device: ServerSpecsInput): boolean {
    return device.server?.teeCapable === TeeCapability.TRUE;
  }

  static isTeeCapable(device: ServerSpecsInput): boolean {
    const gpuModel = ServerSpecHelper.hardwareSummary(device).gpuModel;
    return hardwareEligibleLayerSlugs(gpuModel, ServerSpecHelper.teeCapable(device)).includes(
      LAYER_SLUGS.tee.TEE_SETUP,
    );
  }

  static storageLayouts(device: ServerSpecsInput): StorageLayouts {
    const layouts = device.server?.storageLayouts;
    if (isRecord(layouts) && Array.isArray(layouts.configs) && isRecord(layouts.default)) {
      return layouts as StorageLayouts;
    }
    return { configs: [], default: {} };
  }

  static defaultDiskLayouts(device: ServerSpecsInput) {
    const layouts = ServerSpecHelper.storageLayouts(device);

    const defaultGroups: StorageLayoutDiskGroup[] = [
      ...(layouts.default.os_disks_group ? [layouts.default.os_disks_group] : []),
      ...(layouts.default.data_disks_groups ?? []),
      ...(layouts.default.cold_storage_disks_groups ?? []),
    ];
    const defaultConfigByGroup = new Map(defaultGroups.map((group) => [group.group, group]));

    return layouts.configs.map((layout) => {
      const defaults = defaultConfigByGroup.get(layout.disk_group_name);
      return {
        config: defaults?.config || '',
        format: defaults?.file_system || '',
        mountpoint: defaults?.mountpoint || '',
        diskType: layout.disk_type,
        disks: layout.disks.map((disk) => disk.wwn || disk.serial || disk.name),
      };
    });
  }

  static activeDeployment(deployments: DeploymentWithReservation[]): DeploymentWithReservation | undefined {
    return deployments?.find((d) => d.endDate === null);
  }

  static reservationType(
    activeDeployment: DeploymentWithReservation | undefined,
    activeInvite: InviteWithOrg | undefined,
    role: DeviceRole | string | null | undefined,
  ): string | null {
    if (activeDeployment?.reservation) {
      return activeDeployment.reservation.internalProvision ? 'Self-Provisioned' : 'Rented';
    }
    if (activeInvite) return 'Invite Pending';
    if (role === DeviceRole.OffMarketplaceHost) return 'Off Market';
    return null;
  }

  static reservationData(activeDeployment: DeploymentWithReservation | undefined, gpuCount: number | null) {
    const reservation = activeDeployment?.reservation;
    if (!reservation || reservation.price == null || reservation.billingFrequency == null) {
      return null;
    }

    const { price, billingFrequency } = reservation;
    const hoursPerCycle = getBillingFrequencyHours(billingFrequency);

    return {
      price,
      pricePerGpuHour: hoursPerCycle && gpuCount ? price / hoursPerCycle / gpuCount : null,
      pricePerDeviceHour: hoursPerCycle ? price / hoursPerCycle : null,
      billingFrequency,
    };
  }

  static activeReservationInvite(
    invites: (ServersInReservationInvite & { reservationInvite: InviteWithOrg })[],
  ): InviteWithOrg | undefined {
    return invites?.find(
      (d) =>
        d.reservationInvite.dateAccepted === null &&
        d.reservationInvite.dateDeleted === null &&
        d.reservationInvite.dateExpires > new Date(),
    )?.reservationInvite;
  }

  static reservationInviteData(invite: InviteWithOrg | undefined, gpuCount: number | null) {
    if (!invite) return null;

    const hoursPerCycle = getBillingFrequencyHours(invite.billingFrequency);

    return {
      id: invite.id,
      inviteeEmail: invite.inviteeEmail,
      inviteeOrganization: {
        id: invite.inviteeOrganization?.id,
        name: invite.inviteeOrganization?.name,
      },
      price: invite.price,
      pricePerGpuHour: hoursPerCycle && gpuCount ? invite.price / hoursPerCycle / gpuCount : null,
      pricePerDeviceHour: hoursPerCycle ? invite.price / hoursPerCycle : null,
      billingFrequency: invite.billingFrequency,
      dateCreated: invite.dateCreated,
      dateExpires: invite.dateExpires,
      dateAccepted: invite.dateAccepted,
      dateDeleted: invite.dateDeleted,
      interruptibleNoticePeriod: invite.interruptibleNoticePeriod,
    };
  }
}
