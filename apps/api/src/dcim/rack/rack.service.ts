import { Injectable } from '@nestjs/common';
import type { DcimRack, DcimRackListQuery, DcimRackListResponse } from '@repo/api-client';
import { RackPresenter } from './rack.presenter';
import { CreateRackInput, RackRecord, UpdateRackInput } from './rack.record';

@Injectable()
export class RackService {
  async list(query: DcimRackListQuery): Promise<DcimRackListResponse> {
    const result = await RackRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => RackPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimRack> {
    const record = await RackRecord.findByIdOrThrow(id);
    return RackPresenter.toResponse(record);
  }

  async create(input: CreateRackInput): Promise<DcimRack> {
    const record = await RackRecord.create(input);
    return RackPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateRackInput): Promise<DcimRack> {
    const record = await RackRecord.updateById(id, input);
    return RackPresenter.toResponse(record);
  }

  async delete(id: string) {
    await RackRecord.deleteById(id);
  }
}
