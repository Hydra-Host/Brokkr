import type { DcimInterface, DeviceInterfaceWithIps } from '@repo/api-client';
import type { InterfaceRecord, InterfaceWithIps } from './interface.record';

export class InterfacePresenter {
  // The `as` bridges the nominal Prisma-enum vs api-client-zod-enum gap; the values are string-equal.
  private static baseFields(src: InterfaceRecord['data'] | InterfaceWithIps): DcimInterface {
    return {
      id: src.id,
      name: src.name,
      type: src.type,
      enabled: src.enabled,
      mtu: src.mtu,
      macAddress: src.macAddress,
      speed: src.speed,
      mgmtOnly: src.mgmtOnly,
      markConnected: src.markConnected,
      mode: src.mode,
      description: src.description,
      linkType: src.linkType,
      guid: src.guid,
      portState: src.portState,
      maxSpeedGbps: src.maxSpeedGbps,
      pciDeviceId: src.pciDeviceId,
      lldpNeighborName: src.lldpNeighborName,
      lldpNeighborPort: src.lldpNeighborPort,
      lldpNeighborDescr: src.lldpNeighborDescr,
      lldpNeighborMgmtIp: src.lldpNeighborMgmtIp,
      deviceId: src.deviceId,
      lagId: src.lagId,
      parentId: src.parentId,
      untaggedVlanId: src.untaggedVlanId,
      createdAt: src.createdAt,
      updatedAt: src.updatedAt,
    } as DcimInterface;
  }

  static toResponse(record: InterfaceRecord): DcimInterface {
    return this.baseFields(record.data);
  }

  static toResponseWithIps(row: InterfaceWithIps): DeviceInterfaceWithIps {
    return {
      ...this.baseFields(row),
      // Load-bearing projection (mirrors toInterfaceResponse): ts-rest does not validate responses,
      // so widening the Prisma include would silently leak sensitive IpAddress columns.
      ipAddresses: row.ipAddresses.map(({ id, address, status }) => ({ id, address, status })),
    } as DeviceInterfaceWithIps;
  }
}
