import type { DcimRack } from '@repo/api-client';
import type { RackRecord } from './rack.record';

export class RackPresenter {
  static toResponse(record: RackRecord): DcimRack {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      status: data.status,
      role: data.role,
      heightU: data.heightU,
      startingUnit: data.startingUnit,
      description: data.description,
      serial: data.serial,
      assetTag: data.assetTag,
      zoneId: data.zoneId,
      organizationId: data.organizationId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimRack;
  }
}
