import {
  Cpu,
  Deployment,
  DeviceNetworkType,
  DeviceRole,
  DeviceStatus,
  DeviceType,
  Gpu,
  Interface,
  IpAddress,
  IpxeBuildTarget,
  MemoryConfig,
  StorageDrive,
} from '@repo/database';
import { mapStatusToDeploymentStatus } from '@repo/utils';
import { isIP } from 'node:net';
import { z } from 'zod';
import { type HardwareSummary, projectHardwareSummary } from './hardware-summary.projection';

export const DeviceSpecColumnsSchema = z.object({
  id: z.string(),
  name: z.string(),
  nickname: z.string().nullable(),
  // Declared so active-record Zod strip doesn't drop it from role aggregates.
  // `.optional()` keeps pre-column device fixtures parsing.
  internalName: z.string().nullable().optional(),
  systemSerial: z.string().nullable(),
  chassisSerial: z.string().nullable(),
  serial: z.string().nullable(),
  baseboardSerial: z.string().nullable(),
  systemUuid: z.string().nullable(),
  productSku: z.string().nullable(),
  assetTag: z.string().nullable(),

  role: z.nativeEnum(DeviceRole).nullable(),
  status: z.nativeEnum(DeviceStatus),
  deviceType: z.nativeEnum(DeviceType).nullable(),

  networkType: z.nativeEnum(DeviceNetworkType).nullable(),

  architecture: z.string().nullable(),
  uefiBoot: z.boolean().nullable(),
  secureBootEnabled: z.boolean().nullable(),
  iommuEnabled: z.boolean().nullable(),
  sriovEnabled: z.boolean().nullable(),
  // Declared so the active-record parse (Zod strip mode) doesn't strip it — the presenter would read
  // undefined and return null on every read. `.optional()` keeps pre-column device fixtures parsing.
  ipxeBuildTarget: z.nativeEnum(IpxeBuildTarget).nullable().optional(),

  zoneId: z.string().nullable(),
  zone: z
    .object({ name: z.string(), region: z.object({ name: z.string() }).nullable() })
    .nullable()
    .optional(),
  supplierId: z.string().nullable(),
  deviceModelId: z.string().nullable(),

  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),

  interfaces: z
    .custom<(Interface & { ipAddresses: (IpAddress & { natOutside?: Pick<IpAddress, 'address'>[] })[] })[]>()
    .optional(),
  cpus: z.custom<Cpu[]>().optional(),
  gpus: z.custom<Gpu[]>().optional(),
  storageDrives: z.custom<StorageDrive[]>().optional(),
  memoryConfig: z.custom<MemoryConfig | null>().optional(),
});

export type DeviceSpecColumns = z.infer<typeof DeviceSpecColumnsSchema>;

export class DeviceSpecHelper {
  static ipv4(device: Partial<DeviceSpecColumns>): string {
    return DeviceSpecHelper.firstDataIp(device, 4) ?? '';
  }

  static ipv6(device: Partial<DeviceSpecColumns>): string {
    return DeviceSpecHelper.firstDataIp(device, 6) ?? '';
  }

  static mac(device: Partial<DeviceSpecColumns>): string | null {
    if (!device.interfaces) return null;
    const iface = device.interfaces.find((i) => !i.mgmtOnly);
    return iface?.macAddress ?? null;
  }

  static ipmiIp(device: Partial<DeviceSpecColumns>): string | null {
    return DeviceSpecHelper.firstInterfaceIp(device.interfaces, { mgmtOnly: true, family: 4 });
  }

  protected static firstDataIp(device: Partial<DeviceSpecColumns>, family: 4 | 6): string | null {
    const natOnly = device.networkType === DeviceNetworkType.NAT;
    for (const iface of device.interfaces ?? []) {
      if (iface.mgmtOnly) continue;
      for (const ipAddress of iface.ipAddresses ?? []) {
        const address = ipAddress.natOutside?.[0]?.address ?? (natOnly ? null : ipAddress.address);
        if (!address) continue;
        const host = address.split('/')[0] ?? '';
        if (isIP(host) === family) return host;
      }
    }
    return null;
  }

  protected static firstInterfaceIp(
    interfaces: Partial<DeviceSpecColumns>['interfaces'],
    opts: { mgmtOnly: boolean; family: 4 | 6 },
  ): string | null {
    for (const iface of interfaces ?? []) {
      if (iface.mgmtOnly !== opts.mgmtOnly) continue;
      for (const { address } of iface.ipAddresses ?? []) {
        const host = address.split('/')[0] ?? '';
        if (isIP(host) === opts.family) return host;
      }
    }
    return null;
  }

  static hardwareSummary(device: Partial<DeviceSpecColumns>): HardwareSummary {
    return projectHardwareSummary({
      cpus: device.cpus ?? [],
      gpus: device.gpus ?? [],
      storageDrives: device.storageDrives ?? [],
      memoryConfig: device.memoryConfig ?? null,
    });
  }

  static specs(device: Partial<DeviceSpecColumns>) {
    const hw = DeviceSpecHelper.hardwareSummary(device);
    const { cpuPhysicalCount, cpuCoreCount, cpuThreadCount } = hw;

    return {
      cpu: {
        coresPerCpu: cpuCoreCount && cpuPhysicalCount ? cpuCoreCount / cpuPhysicalCount : null,
        count: cpuPhysicalCount,
        model: hw.cpuModel,
        threadsPerCore: cpuThreadCount && cpuCoreCount ? cpuThreadCount / cpuCoreCount : null,
        threadsPerCpu: cpuThreadCount && cpuPhysicalCount ? cpuThreadCount / cpuPhysicalCount : null,
        totalCores: cpuCoreCount,
        totalThreads: cpuThreadCount,
      },
      gpu: {
        count: hw.gpuCount,
        model: hw.gpuModel,
      },
      memory: {
        total: hw.memoryGb,
      },
      storage: {
        hddCount: hw.hddCount,
        hddSize: hw.hddSize,
        nvmeCount: hw.nvmeCount,
        nvmeSize: hw.nvmeSize,
        ssdCount: hw.ssdCount,
        ssdSize: hw.ssdSize,
        total: (hw.hddSize ?? 0) + (hw.nvmeSize ?? 0) + (hw.ssdSize ?? 0),
      },
    };
  }

  static region(device: Partial<DeviceSpecColumns>): string {
    return device.zone?.region?.name ?? '';
  }

  static zoneName(device: Partial<DeviceSpecColumns>): string {
    return device.zone?.name ?? '';
  }

  static status(device: Partial<DeviceSpecColumns>, activeDeployment?: Deployment | null): string {
    if (device.role === DeviceRole.OffMarketplaceHost) {
      return 'Off Market';
    }

    const statusStr = (device.status ?? 'active').toLowerCase();

    if (activeDeployment) {
      return mapStatusToDeploymentStatus(statusStr);
    }

    return statusStr;
  }
}
