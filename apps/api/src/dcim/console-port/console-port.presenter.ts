import type { DcimConsolePort } from '@repo/api-client';
import type { ConsolePortRecord } from './console-port.record';

export class ConsolePortPresenter {
  static toResponse(record: ConsolePortRecord): DcimConsolePort {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      speed: data.speed,
      description: data.description,
      deviceId: data.deviceId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    } as DcimConsolePort;
  }
}
