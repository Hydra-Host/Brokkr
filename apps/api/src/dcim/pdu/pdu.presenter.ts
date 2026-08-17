import type { Pdu } from '@repo/api-client';
import type { PduAggregate } from './pdu.record';

export class PduPresenter {
  static toResponse(data: PduAggregate): Pdu {
    return {
      deviceId: data.id,
      name: data.name,
      nickname: data.nickname,
      status: data.status,
      powerStatus: data.pdu.powerStatus,
      outletCount: data.pdu.outletCount,
      ratedAmperage: data.pdu.ratedAmperage,
      voltageType: data.pdu.voltageType,
      zoneId: data.zoneId,
      zoneName: data.zone?.name ?? null,
      supplierId: data.supplierId,
      supplierName: data.supplier?.name ?? null,
      deletedAt: data.deletedAt,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
