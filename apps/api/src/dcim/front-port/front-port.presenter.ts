import type { DcimFrontPort } from '@repo/api-client';
import type { FrontPortRecord } from './front-port.record';

export class FrontPortPresenter {
  static toResponse(record: FrontPortRecord): DcimFrontPort {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      rearPortPosition: data.rearPortPosition,
      description: data.description,
      deviceId: data.deviceId,
      rearPortId: data.rearPortId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimFrontPort;
  }
}
