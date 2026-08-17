import { Injectable } from '@nestjs/common';
import type { DcimRearPort, DcimRearPortListQuery, DcimRearPortListResponse } from '@repo/api-client';
import { RearPortPresenter } from './rear-port.presenter';
import { CreateRearPortInput, RearPortRecord, UpdateRearPortInput } from './rear-port.record';

@Injectable()
export class RearPortService {
  async list(query: DcimRearPortListQuery): Promise<DcimRearPortListResponse> {
    const result = await RearPortRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => RearPortPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimRearPort> {
    const record = await RearPortRecord.findByIdOrThrow(id);
    return RearPortPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreateRearPortInput): Promise<DcimRearPort> {
    const record = await RearPortRecord.createForDevice(deviceId, input);
    return RearPortPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateRearPortInput): Promise<DcimRearPort> {
    const record = await RearPortRecord.updateById(id, input);
    return RearPortPresenter.toResponse(record);
  }

  async delete(id: string) {
    await RearPortRecord.deleteById(id);
  }
}
