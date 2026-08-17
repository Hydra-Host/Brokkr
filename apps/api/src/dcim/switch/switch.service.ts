import { Injectable } from '@nestjs/common';
import type { Switch, SwitchListResponse, SwitchesQuery, UpdateSwitchRequest } from '@repo/api-client';
import { SwitchPresenter } from './switch.presenter';
import { SwitchRecord } from './switch.record';

@Injectable()
export class SwitchService {
  async list(query: SwitchesQuery): Promise<SwitchListResponse> {
    const result = await SwitchRecord.listPaginated(query);
    return { data: result.data.map((d) => SwitchPresenter.toResponse(d)), meta: result.meta };
  }

  async findByDeviceId(deviceId: string): Promise<Switch> {
    const record = await SwitchRecord.findByDeviceIdOrThrow(deviceId, { includeDeleted: true });
    return SwitchPresenter.toResponse(record.data);
  }

  async update(deviceId: string, body: UpdateSwitchRequest): Promise<Switch> {
    const record = await SwitchRecord.updateByDeviceId(deviceId, body);
    return SwitchPresenter.toResponse(record.data);
  }

  async decommission(deviceId: string): Promise<void> {
    await SwitchRecord.decommissionByDeviceId(deviceId);
  }
}
