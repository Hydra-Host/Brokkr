import type { DcimCable } from '@repo/api-client';
import type { CableRecord } from './cable.record';

export class CablePresenter {
  static toResponse(record: CableRecord): DcimCable {
    const data = record.data;
    return {
      id: data.id,
      type: data.type,
      status: data.status,
      label: data.label,
      color: data.color,
      length: data.length != null ? Number(data.length) : null,
      lengthUnit: data.lengthUnit,
      description: data.description,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimCable;
  }
}
