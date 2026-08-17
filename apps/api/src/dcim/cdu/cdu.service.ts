import { Injectable } from '@nestjs/common';
import type { Cdu, CduListResponse, CdusQuery, UpdateCduRequest } from '@repo/api-client';
import { CduPresenter } from './cdu.presenter';
import { CduRecord } from './cdu.record';

@Injectable()
export class CduService {
  async list(query: CdusQuery): Promise<CduListResponse> {
    const result = await CduRecord.listPaginated(query);
    return { data: result.data.map((d) => CduPresenter.toResponse(d)), meta: result.meta };
  }

  async findByDeviceId(deviceId: string): Promise<Cdu> {
    const record = await CduRecord.findByDeviceIdOrThrow(deviceId, { includeDeleted: true });
    return CduPresenter.toResponse(record.data);
  }

  async update(deviceId: string, body: UpdateCduRequest): Promise<Cdu> {
    const record = await CduRecord.updateByDeviceId(deviceId, body);
    return CduPresenter.toResponse(record.data);
  }

  async decommission(deviceId: string): Promise<void> {
    await CduRecord.decommissionByDeviceId(deviceId);
  }
}
