import type { Switch } from '@repo/api-client';
import type { SwitchAggregate } from './switch.record';

export class SwitchPresenter {
  static toResponse(data: SwitchAggregate): Switch {
    return {
      deviceId: data.id,
      name: data.name,
      nickname: data.nickname,
      status: data.status,
      powerStatus: data.switch.powerStatus,
      switchRole: data.switch.switchRole,
      fabric: data.switch.fabric,
      portCount: data.switch.portCount,
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
