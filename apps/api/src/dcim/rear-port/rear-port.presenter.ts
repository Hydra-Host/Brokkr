import type { DcimRearPort } from '@repo/api-client';
import type { RearPortRecord } from './rear-port.record';

export class RearPortPresenter {
  static toResponse(record: RearPortRecord): DcimRearPort {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      positions: data.positions,
      description: data.description,
      deviceId: data.deviceId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimRearPort;
  }
}
