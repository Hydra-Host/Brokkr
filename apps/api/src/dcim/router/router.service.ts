import { Injectable } from '@nestjs/common';
import type { Router, RouterListResponse, RoutersQuery, UpdateRouterRequest } from '@repo/api-client';
import { RouterPresenter } from './router.presenter';
import { RouterRecord } from './router.record';

@Injectable()
export class RouterService {
  async list(query: RoutersQuery): Promise<RouterListResponse> {
    const result = await RouterRecord.listPaginated(query);
    return { data: result.data.map((d) => RouterPresenter.toResponse(d)), meta: result.meta };
  }

  async findByDeviceId(deviceId: string): Promise<Router> {
    const record = await RouterRecord.findByDeviceIdOrThrow(deviceId, { includeDeleted: true });
    return RouterPresenter.toResponse(record.data);
  }

  async update(deviceId: string, body: UpdateRouterRequest): Promise<Router> {
    const record = await RouterRecord.updateByDeviceId(deviceId, body);
    return RouterPresenter.toResponse(record.data);
  }

  async decommission(deviceId: string): Promise<void> {
    await RouterRecord.decommissionByDeviceId(deviceId);
  }
}
