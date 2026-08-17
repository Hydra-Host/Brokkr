import { Injectable } from '@nestjs/common';
import type { DcimFrontPort, DcimFrontPortListQuery, DcimFrontPortListResponse } from '@repo/api-client';
import { FrontPortPresenter } from './front-port.presenter';
import { CreateFrontPortInput, FrontPortRecord, UpdateFrontPortInput } from './front-port.record';

@Injectable()
export class FrontPortService {
  async list(query: DcimFrontPortListQuery): Promise<DcimFrontPortListResponse> {
    const result = await FrontPortRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => FrontPortPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimFrontPort> {
    const record = await FrontPortRecord.findByIdOrThrow(id);
    return FrontPortPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreateFrontPortInput): Promise<DcimFrontPort> {
    const record = await FrontPortRecord.createForDevice(deviceId, input);
    return FrontPortPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateFrontPortInput): Promise<DcimFrontPort> {
    const record = await FrontPortRecord.updateById(id, input);
    return FrontPortPresenter.toResponse(record);
  }

  async delete(id: string) {
    await FrontPortRecord.deleteById(id);
  }
}
