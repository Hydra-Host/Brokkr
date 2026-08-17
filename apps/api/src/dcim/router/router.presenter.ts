import type { Router } from '@repo/api-client';
import type { RouterAggregate } from './router.record';

export class RouterPresenter {
  static toResponse(data: RouterAggregate): Router {
    return {
      deviceId: data.id,
      name: data.name,
      nickname: data.nickname,
      status: data.status,
      powerStatus: data.router.powerStatus,
      routerType: data.router.routerType,
      bgpAsn: data.router.bgpAsn,
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
