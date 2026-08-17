import type { DcimPowerPort } from '@repo/api-client';
import type { PowerPortRecord } from './power-port.record';

export class PowerPortPresenter {
  static toResponse(record: PowerPortRecord): DcimPowerPort {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      maximumDraw: data.maximumDraw,
      allocatedDraw: data.allocatedDraw,
      description: data.description,
      deviceId: data.deviceId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimPowerPort;
  }
}
