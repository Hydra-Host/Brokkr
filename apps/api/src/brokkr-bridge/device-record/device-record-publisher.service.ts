import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceRole, Prisma, TagObjectType, ZoneNetworkType } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import {
  ConfigAtomWriter,
  deviceData,
  deviceLookup,
  devicePointers,
  deviceRecord,
  type DeviceLookupKind,
} from 'src/common/redis';
import { NetplanService } from 'src/devices/netplan/netplan.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import { resolveLocationEastWestNetworkType } from '../common/zone-east-west-network-type';
import type { IpxeIdentifierBundle } from '../types/render-request.types';
import { DeviceRecordSchema, type DeviceRecord } from './device-record.schema';
import { identifierBundleFor, type IdentifierBundle } from './identifier-bundle';
import { placeholderIdFromBundle } from './placeholder-id';

export const TTL_PLACEHOLDER_DEVICE_RECORD_SECONDS = 24 * 60 * 60;

const trackingKeySchema = z.array(z.string());

const PUBLISHED_DEVICE_ROLES: ReadonlySet<DeviceRole> = new Set([
  DeviceRole.Server,
  DeviceRole.Baremetal,
  DeviceRole.DiscoveredHost,
  DeviceRole.OffMarketplaceHost,
  DeviceRole.Decommissioned,
  DeviceRole.Hypervisor,
  DeviceRole.VM,
  DeviceRole.Cluster,
]);

export const MONITORED_DEVICE_ROLES: ReadonlySet<DeviceRole> = new Set([
  DeviceRole.Server,
  DeviceRole.Baremetal,
  DeviceRole.DiscoveredHost,
  DeviceRole.OffMarketplaceHost,
  DeviceRole.Decommissioned,
  DeviceRole.Hypervisor,
  DeviceRole.PDU,
  DeviceRole.CDU,
]);

const NETPLAN_COMPUTED_ROLES: ReadonlySet<DeviceRole> = new Set([
  DeviceRole.Server,
  DeviceRole.Baremetal,
  DeviceRole.DiscoveredHost,
]);

export type DeviceRecordWriteResult = { written: boolean; reason?: string };

const deviceRecordSelect = {
  id: true,
  status: true,
  role: true,
  lastJobId: true,
  ipmiBootDeviceOverride: true,
  server: { select: { lifecycleStatus: true } },
  zoneId: true,
  zone: { select: { networkType: true } },
  serial: true,
  systemUuid: true,
  chassisSerial: true,
  baseboardSerial: true,
  deviceModel: { select: { slug: true, model: true, manufacturer: true } },
  solConfig: { select: { optimalPort: true, baudRate: true, resolvedPort: true, resolvedBaud: true } },
  interfaces: {
    where: { deletedAt: null },
    select: {
      macAddress: true,
      mgmtOnly: true,
      ipAddresses: { where: { deletedAt: null }, select: { address: true } },
    },
  },
} as const satisfies Prisma.DeviceSelect;

type DeviceRecordRow = Prisma.DeviceGetPayload<{ select: typeof deviceRecordSelect }>;

// TagAssignment is polymorphic (objectType/objectId), so the device select cannot carry it — tags come from a second query.
const deviceTagAssignmentSelect = { tag: { select: { slug: true } } } as const satisfies Prisma.TagAssignmentSelect;

type TaggedDevice = {
  tagAssignments: Array<Prisma.TagAssignmentGetPayload<{ select: typeof deviceTagAssignmentSelect }>>;
};

export const deviceDataSyncSelect = {
  id: true,
  role: true,
  deviceModel: { select: { slug: true, model: true, manufacturer: true } },
  interfaces: {
    where: { deletedAt: null },
    select: { mgmtOnly: true, ipAddresses: { where: { deletedAt: null }, select: { address: true } } },
  },
} as const satisfies Prisma.DeviceSelect;

export type DeviceDataSyncRow = Prisma.DeviceGetPayload<{ select: typeof deviceDataSyncSelect }>;

// Every lifecycle hook that mutates boot-relevant state goes through writeForDevice so the iPXE chain never reads stale identifiers.
@Injectable()
export class DeviceRecordPublisher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly atomWriter: ConfigAtomWriter,
    private readonly netplanService: NetplanService,
    @Logger(DeviceRecordPublisher.name) private readonly logger: LoggerService,
  ) {}

  static warnIfPublishSkipped(
    logger: LoggerService,
    result: DeviceRecordWriteResult,
    opLabel: string,
    deviceId: string,
    jobId?: string,
  ): void {
    if (result.written) {
      return;
    }
    if (result.reason === 'role-not-published') {
      logger.log(
        `Skipped device_record publish for ${opLabel} of ${deviceId}: role is not in the publish allow-list (expected for infra roles); proceeding with reboot`,
        jobId,
      );
      return;
    }
    logger.warn(
      `Skipped device_record publish for ${opLabel} of ${deviceId} (reason: ${result.reason ?? 'unknown'}); the boot may read a stale device_record (render-on-miss is the backstop)`,
      jobId,
    );
  }

  async writeForDevice(deviceId: string, opts: { requestId?: string | null } = {}): Promise<DeviceRecordWriteResult> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: deviceRecordSelect,
    });
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }
    if (!device.zoneId) {
      throw new BadRequestException(`Device ${device.id} is not assigned to a zone`);
    }
    // role=null IS an commissioning record — always publishable (per-caller opt-in would let republish paths serve a stale boot record).
    const isCommissioning = device.role == null;
    if (!isCommissioning && !PUBLISHED_DEVICE_ROLES.has(device.role)) {
      this.logger.log(
        `Skipping device_record publish for device ${device.id}: role ${device.role} is not in the publish allow-list`,
      );
      await this.syncDeviceData(device.zoneId, device);
      return { written: false, reason: 'role-not-published' };
    }

    const locationNetworkType = await resolveLocationEastWestNetworkType(this.prisma, device.zoneId);
    const isVpc = device.zone?.networkType === ZoneNetworkType.VPC;
    const deploymentOs = await this.resolveDeploymentOs(device.id);
    const tagAssignments = await this.loadDeviceTagAssignments(device.id);
    // The netplan YAML becomes kernel ip= options on the bridge; a render failure must not abort the boot-critical write — fall back to null (DHCP).
    const netplanEligible = isCommissioning || (device.role != null && NETPLAN_COMPUTED_ROLES.has(device.role));
    let netplan: string | null = null;
    if (netplanEligible) {
      try {
        netplan = await this.netplanService.renderForDevice(device.id, 'live');
      } catch (error) {
        this.logger.warn(
          `[device_record] netplan render failed for ${device.id}; publishing with DHCP (null) netplan: ${getErrorMessage(error)}`,
        );
        netplan = null;
      }
    }
    const record: DeviceRecord = buildRecord(
      { ...device, tagAssignments },
      locationNetworkType,
      isVpc,
      deploymentOs,
      netplan,
    );
    const bundle = identifierBundleFor(device);

    const result = await this.write(device.zoneId, record, bundle, {
      requestId: opts.requestId ?? null,
      ttlSeconds: 0,
    });
    // On a stale-race skip a newer publish owns the atom — don't clobber (unmonitored roles still get their idempotent DEL); best-effort so a monitoring blip can't mask the publish result.
    const isMonitored = device.role == null || MONITORED_DEVICE_ROLES.has(device.role);
    if (result.written || !isMonitored) {
      try {
        await this.syncDeviceData(device.zoneId, device);
      } catch (error) {
        this.logger.warn(
          `Published device_record for ${device.id} but failed to sync device:{id}:data (monitoring atom); ` +
            `it will be synced on the next publish or reconciler sweep: ${getErrorMessage(error)}`,
        );
      }
    }
    return result;
  }

  async syncDeviceData(zoneId: string, device: DeviceDataSyncRow): Promise<'written' | 'deleted'> {
    const isMonitored = device.role == null || MONITORED_DEVICE_ROLES.has(device.role);
    if (isMonitored) {
      await this.writeDeviceData(zoneId, device);
      return 'written';
    }
    await this.deleteDeviceData(zoneId, device.id);
    return 'deleted';
  }

  async syncDeviceDataBatch(
    zoneId: string,
    devices: DeviceDataSyncRow[],
  ): Promise<{ written: number; deleted: number }> {
    if (devices.length === 0) {
      return { written: 0, deleted: 0 };
    }
    const ops = devices.map((device) =>
      device.role == null || MONITORED_DEVICE_ROLES.has(device.role)
        ? { op: 'set' as const, key: deviceData(device.id), value: JSON.stringify(buildDeviceDataBlob(device)) }
        : { op: 'del' as const, key: deviceData(device.id) },
    );
    await this.atomWriter.writeMulti(zoneId, ops);
    const written = ops.filter((op) => op.op === 'set').length;
    return { written, deleted: ops.length - written };
  }

  async purgeDeviceData(zoneId: string, deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) {
      return;
    }
    await this.atomWriter.writeMulti(
      zoneId,
      deviceIds.map((id) => ({ op: 'del' as const, key: deviceData(id) })),
    );
  }

  private async writeDeviceData(zoneId: string, device: DeviceDataSyncRow): Promise<void> {
    await this.atomWriter.writeMulti(zoneId, [
      { op: 'set', key: deviceData(device.id), value: JSON.stringify(buildDeviceDataBlob(device)) },
    ]);
  }

  private async deleteDeviceData(zoneId: string, deviceId: string): Promise<void> {
    await this.atomWriter.writeMulti(zoneId, [{ op: 'del', key: deviceData(deviceId) }]);
  }

  async writePlaceholder(
    bundle: IpxeIdentifierBundle,
    params: { buildarch: string | null; zoneId: string; requestId?: string | null },
  ): Promise<{ id: string; result: DeviceRecordWriteResult }> {
    if (!hasAnyIdentifier(bundle)) {
      throw new BadRequestException('Placeholder device_record requires at least one identifier');
    }
    const id = placeholderIdFromBundle(bundle);
    const record: DeviceRecord = {
      id,
      is_placeholder: true,
      status: null,
      role: null,
      installed_os: null,
      rescue_os: null,
      platform_tags: platformTagsOf(null),
      device_type: null,
      netplan: null,
      serial_port_recommended: null,
      serial_baud_recommended: null,
      location_network_type: null,
      is_vpc: false,
      last_job_id: null,
      buildarch: params.buildarch,
    };
    const result = await this.write(params.zoneId, record, bundle, {
      requestId: params.requestId ?? null,
      ttlSeconds: TTL_PLACEHOLDER_DEVICE_RECORD_SECONDS,
    });
    if (!result.written) {
      this.logger.warn(
        `SKIPPED placeholder device_record (id=${id}, zone=${params.zoneId}): ${result.reason ?? 'unknown'}; ` +
          `Redis retains the existing record/pointers`,
      );
      return { id, result };
    }
    this.logger.log(
      `Wrote placeholder device_record (id=${id}, zone=${params.zoneId}, pointers=${pointerKeysFor(bundle).length}, buildarch=${params.buildarch ?? 'null'})`,
    );
    return { id, result };
  }

  // Must never throw — runs from a fire-and-forget listener; missing row/zoneId are logged no-ops.
  async delete(deviceId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        zoneId: true,
        serial: true,
        systemUuid: true,
        chassisSerial: true,
        baseboardSerial: true,
        interfaces: { where: { deletedAt: null }, select: { macAddress: true, mgmtOnly: true } },
      },
    });
    if (!device) {
      this.logger.log(`device_record teardown skipped: device ${deviceId} row not found (nothing to tear down)`);
      return;
    }
    if (!device.zoneId) {
      this.logger.log(
        `device_record teardown skipped for device ${device.id}: no zone assigned, so no zone-prefixed atoms could exist`,
      );
      return;
    }
    const recordKey = deviceRecord(device.id);
    const trackingKey = devicePointers(device.id);

    let trackedPointerKeys: string[];
    try {
      trackedPointerKeys = (await this.atomWriter.readJson(device.zoneId, trackingKey, trackingKeySchema)) ?? [];
    } catch (error) {
      this.logger.warn(
        `Tracking key for device ${device.id} unreadable; falling back to identifiers: ${getErrorMessage(error)}`,
      );
      trackedPointerKeys = [];
    }

    const fallbackPointerKeys = pointerKeysFor(identifierBundleFor(device));
    const allPointerKeys = [...new Set([...trackedPointerKeys, ...fallbackPointerKeys])];

    const operations: Array<{ op: 'del'; key: string }> = [
      { op: 'del', key: recordKey },
      { op: 'del', key: deviceData(device.id) },
      { op: 'del', key: trackingKey },
      ...allPointerKeys.map((key) => ({ op: 'del' as const, key })),
    ];
    await this.atomWriter.writeMulti(device.zoneId, operations);
    this.logger.log(`Deleted device_record + data + ${allPointerKeys.length} pointer(s) for device ${device.id}`);
  }

  // Pointer rotation runs under WATCH/MULTI so stale pointers (NIC swap, BMC reseat) are DEL'd in the same transaction that adds new ones.
  private async write(
    zoneId: string,
    record: DeviceRecord,
    bundle: IdentifierBundle,
    opts: { requestId: string | null; ttlSeconds: number },
  ): Promise<DeviceRecordWriteResult> {
    // Record envelope first — a failure skips pointer rotation, so pointers never reference a missing key.
    const writeResult = await this.atomWriter.writeAtomJson(
      zoneId,
      deviceRecord(record.id),
      record,
      DeviceRecordSchema,
      opts.ttlSeconds,
      { request_id: opts.requestId },
    );
    if (!writeResult.written) {
      this.logger.debug(
        `Skipped pointer rotation for device id=${record.id} (zone=${zoneId}) — record write was ${writeResult.reason}`,
      );
      return { written: false, reason: writeResult.reason };
    }

    const newPointerKeys = pointerKeysFor(bundle);
    const newPointerSet = new Set(newPointerKeys);
    let stalePointerCount = 0;

    // Mutator is pure so it's safe to re-run on WATCH retry; only side effect is stalePointerCount for the log.
    const result = await this.atomWriter.watchAndExecMulti<string[]>(
      zoneId,
      devicePointers(record.id),
      trackingKeySchema,
      (current) => {
        const previousPointerKeys = current ?? [];
        const stalePointerKeys = previousPointerKeys.filter((key) => !newPointerSet.has(key));
        stalePointerCount = stalePointerKeys.length;

        const extraOps: Array<{ op: 'set' | 'del'; key: string; value?: string; ttl?: number }> = [];
        for (const staleKey of stalePointerKeys) {
          extraOps.push({ op: 'del', key: staleKey });
        }
        for (const pointerKey of newPointerKeys) {
          extraOps.push({
            op: 'set',
            key: pointerKey,
            value: String(record.id),
            ttl: opts.ttlSeconds > 0 ? opts.ttlSeconds : undefined,
          });
        }
        return { value: newPointerKeys, extraOps };
      },
      opts.ttlSeconds,
    );

    const staleLabel = stalePointerCount > 0 ? `, removed ${stalePointerCount} stale pointer(s)` : '';
    this.logger.log(
      `Published device_record for id=${record.id} (zone=${zoneId}, pointers=${newPointerKeys.length}${staleLabel}, attempts=${result.attempts}, ttl=${opts.ttlSeconds > 0 ? `${opts.ttlSeconds}s` : 'none'})`,
    );
    return { written: true };
  }

  private async resolveDeploymentOs(deviceId: string): Promise<{ installed: string | null; rescue: string | null }> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { deviceId }, endDate: null },
      orderBy: { startDate: 'desc' },
      select: {
        baseLayer: { select: { slug: true } },
        rescueLayer: { select: { slug: true } },
      },
    });
    if (!deployment) return { installed: null, rescue: null };
    return {
      installed: deployment.baseLayer?.slug ?? null,
      rescue: deployment.rescueLayer?.slug ?? null,
    };
  }

  private loadDeviceTagAssignments(deviceId: string): Promise<TaggedDevice['tagAssignments']> {
    return this.prisma.tagAssignment.findMany({
      where: { objectType: TagObjectType.DEVICE, objectId: deviceId },
      select: deviceTagAssignmentSelect,
    });
  }
}

function buildRecord(
  device: DeviceRecordRow & TaggedDevice,
  locationNetworkType: string | null,
  isVpc: boolean,
  deploymentOs: { installed: string | null; rescue: string | null },
  netplan: string | null,
): DeviceRecord {
  return {
    id: device.id,
    is_placeholder: false,
    status: device.server?.lifecycleStatus ?? device.status ?? null,
    role: deviceRoleToBootSlug(device.role),
    installed_os: deploymentOs.installed,
    rescue_os: deploymentOs.rescue,
    platform_tags: platformTagsOf(device),
    device_type: device.deviceModel?.slug ?? null,
    netplan,
    serial_port_recommended: device.solConfig?.resolvedPort ?? device.solConfig?.optimalPort ?? null,
    serial_baud_recommended: device.solConfig?.resolvedBaud ?? device.solConfig?.baudRate ?? null,
    location_network_type: locationNetworkType,
    is_vpc: isVpc,
    last_job_id: device.lastJobId ?? null,
    buildarch: null,
  };
}

function platformTagsOf(device: TaggedDevice | null): string[] {
  if (!device) return [];
  const slugs = new Set<string>();
  for (const { tag } of device.tagAssignments) {
    if (tag.slug) slugs.add(tag.slug.toLowerCase());
  }
  return [...slugs].sort();
}

function buildDeviceDataBlob(device: DeviceDataSyncRow): Record<string, unknown> {
  return {
    role: deviceRoleToBootSlug(device.role),
    device_type: device.deviceModel
      ? {
          slug: device.deviceModel.slug,
          model: device.deviceModel.model,
          manufacturer: { name: device.deviceModel.manufacturer },
        }
      : null,
    interfaces: device.interfaces.map((iface) => ({
      mgmt_only: iface.mgmtOnly,
      ip_addresses: iface.ipAddresses.map((ip) => ({ address: ip.address })),
    })),
  };
}

function deviceRoleToBootSlug(role: DeviceRole | null): string | null {
  switch (role) {
    case DeviceRole.Baremetal:
      return 'marketplace-hosts';
    case DeviceRole.Hypervisor:
      return 'hypervisor';
    case DeviceRole.VM:
      return 'virtual-bmc';
    case DeviceRole.Bridge:
      return 'brokkr-bridge';
    case DeviceRole.Decommissioned:
      return 'decommissioned-hosts';
    case DeviceRole.DiscoveredHost:
      return 'discovered-hosts';
    case DeviceRole.OffMarketplaceHost:
      return 'off-marketplace-hosts';
    case DeviceRole.Cluster:
      return 'cluster';
    case DeviceRole.NetworkSwitch:
    case DeviceRole.Switch:
    case DeviceRole.Router:
      return 'network-switch';
    case DeviceRole.Server:
      return 'marketplace-hosts';
    case DeviceRole.PDU:
      return 'pdu';
    case DeviceRole.CDU:
      return 'cdu';
    default:
      return null;
  }
}

const POINTER_KINDS: ReadonlyArray<{ kind: DeviceLookupKind; bundleField: keyof IpxeIdentifierBundle }> = [
  { kind: 'mac', bundleField: 'mac' },
  { kind: 'ipmi_mac', bundleField: 'ipmi_mac' },
  { kind: 'system_uuid', bundleField: 'system_uuid' },
  { kind: 'serial', bundleField: 'serial' },
  { kind: 'chassis_serial', bundleField: 'chassis_serial' },
  { kind: 'board_serial', bundleField: 'board_serial' },
];

function pointerKeysFor(bundle: IdentifierBundle): string[] {
  const keys = new Set<string>();
  for (const { kind, bundleField } of POINTER_KINDS) {
    const value = bundle[bundleField];
    if (typeof value === 'string' && value.length > 0) {
      keys.add(deviceLookup(kind, value));
    }
  }
  for (const ifaceMac of bundle.interface_macs ?? []) {
    if (ifaceMac.length > 0) {
      keys.add(deviceLookup('mac', ifaceMac));
    }
  }
  return [...keys];
}

function hasAnyIdentifier(bundle: IdentifierBundle): boolean {
  const hasPrimary = POINTER_KINDS.some(({ bundleField }) => {
    const value = bundle[bundleField];
    return typeof value === 'string' && value.length > 0;
  });
  return hasPrimary || (bundle.interface_macs ?? []).some((mac) => mac.length > 0);
}
