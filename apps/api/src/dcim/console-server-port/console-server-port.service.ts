import { Injectable } from '@nestjs/common';
import type {
  DcimConsoleServerPort,
  DcimConsoleServerPortListQuery,
  DcimConsoleServerPortListResponse,
} from '@repo/api-client';
import { ConsoleServerPortPresenter } from './console-server-port.presenter';
import {
  ConsoleServerPortRecord,
  CreateConsoleServerPortInput,
  UpdateConsoleServerPortInput,
} from './console-server-port.record';

@Injectable()
export class ConsoleServerPortService {
  async list(query: DcimConsoleServerPortListQuery): Promise<DcimConsoleServerPortListResponse> {
    const result = await ConsoleServerPortRecord.listPaginated(query);
    return {
      ...result,
      data: result.data.map((r) => ConsoleServerPortPresenter.toResponse(r)),
    };
  }

  async findById(id: string): Promise<DcimConsoleServerPort> {
    const record = await ConsoleServerPortRecord.findByIdOrThrow(id);
    return ConsoleServerPortPresenter.toResponse(record);
  }

  async create(deviceId: string, input: CreateConsoleServerPortInput): Promise<DcimConsoleServerPort> {
    const record = await ConsoleServerPortRecord.createForDevice(deviceId, input);
    return ConsoleServerPortPresenter.toResponse(record);
  }

  async update(id: string, input: UpdateConsoleServerPortInput): Promise<DcimConsoleServerPort> {
    const record = await ConsoleServerPortRecord.updateById(id, input);
    return ConsoleServerPortPresenter.toResponse(record);
  }

  async delete(id: string) {
    await ConsoleServerPortRecord.deleteById(id);
  }
}
