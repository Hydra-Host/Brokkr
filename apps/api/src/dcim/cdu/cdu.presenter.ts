import type { Cdu } from '@repo/api-client';
import type { CduAggregate } from './cdu.record';

export class CduPresenter {
  static toResponse(data: CduAggregate): Cdu {
    return {
      deviceId: data.id,
      name: data.name,
      nickname: data.nickname,
      status: data.status,
      powerStatus: data.cdu.powerStatus,
      coolantType: data.cdu.coolantType,
      ratedFlowRateLpm: data.cdu.ratedFlowRateLpm,
      ratedThermalCapacityKw: data.cdu.ratedThermalCapacityKw,
      airflow: data.cdu.airflow,
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
