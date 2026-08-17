import { Injectable } from '@nestjs/common';
import type { DcimPowerPort, DcimPowerPortListQuery, DcimPowerPortListResponse } from '@repo/api-client';
import { PowerPortPresenter } from './power-port.presenter';
import { CreatePowerPortInput, PowerPortRecord, UpdatePowerPortInput } from './power-port.record';

@Injectable()
export class PowerPortService {
  async list(query: DcimPowerPortListQuery): Promise<DcimPowerPortListResponse> {
    const result = await PowerPortRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => PowerPortPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimPowerPort> {
    const record = await PowerPortRecord.findByIdOrThrow(id);
    return PowerPortPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreatePowerPortInput): Promise<DcimPowerPort> {
    const record = await PowerPortRecord.createForDevice(deviceId, input);
    return PowerPortPresenter.toResponse(record);
  }

  async update(id: string, input: UpdatePowerPortInput): Promise<DcimPowerPort> {
    const record = await PowerPortRecord.updateById(id, input);
    return PowerPortPresenter.toResponse(record);
  }

  async delete(id: string) {
    await PowerPortRecord.deleteById(id);
  }
}
