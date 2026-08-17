import { Injectable } from '@nestjs/common';
import type { DcimConsolePort, DcimConsolePortListQuery, DcimConsolePortListResponse } from '@repo/api-client';
import { ConsolePortPresenter } from './console-port.presenter';
import { ConsolePortRecord, CreateConsolePortInput, UpdateConsolePortInput } from './console-port.record';

@Injectable()
export class ConsolePortService {
  async list(query: DcimConsolePortListQuery): Promise<DcimConsolePortListResponse> {
    const result = await ConsolePortRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => ConsolePortPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimConsolePort> {
    const record = await ConsolePortRecord.findByIdOrThrow(id);
    return ConsolePortPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreateConsolePortInput): Promise<DcimConsolePort> {
    const record = await ConsolePortRecord.createForDevice(deviceId, input);
    return ConsolePortPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateConsolePortInput): Promise<DcimConsolePort> {
    const record = await ConsolePortRecord.updateById(id, input);
    return ConsolePortPresenter.toResponse(record);
  }

  async delete(id: string) {
    await ConsolePortRecord.deleteById(id);
  }
}
