import { Injectable } from '@nestjs/common';
import type { DcimPowerOutlet, DcimPowerOutletListQuery, DcimPowerOutletListResponse } from '@repo/api-client';
import { PowerOutletPresenter } from './power-outlet.presenter';
import { CreatePowerOutletInput, PowerOutletRecord, UpdatePowerOutletInput } from './power-outlet.record';

@Injectable()
export class PowerOutletService {
  async list(query: DcimPowerOutletListQuery): Promise<DcimPowerOutletListResponse> {
    const result = await PowerOutletRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => PowerOutletPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimPowerOutlet> {
    const record = await PowerOutletRecord.findByIdOrThrow(id);
    return PowerOutletPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreatePowerOutletInput): Promise<DcimPowerOutlet> {
    const record = await PowerOutletRecord.createForDevice(deviceId, input);
    return PowerOutletPresenter.toResponse(record);
  }

  async update(id: string, input: UpdatePowerOutletInput): Promise<DcimPowerOutlet> {
    const record = await PowerOutletRecord.updateById(id, input);
    return PowerOutletPresenter.toResponse(record);
  }

  async delete(id: string) {
    await PowerOutletRecord.deleteById(id);
  }
}
