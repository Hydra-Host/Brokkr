import type { DcimPowerOutlet } from '@repo/api-client';
import type { PowerOutletRecord } from './power-outlet.record';

export class PowerOutletPresenter {
  static toResponse(record: PowerOutletRecord): DcimPowerOutlet {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      feedLegPhase: data.feedLegPhase,
      description: data.description,
      deviceId: data.deviceId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimPowerOutlet;
  }
}
