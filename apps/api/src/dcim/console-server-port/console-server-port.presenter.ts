import type { DcimConsoleServerPort } from '@repo/api-client';
import type { ConsoleServerPortRecord } from './console-server-port.record';

export class ConsoleServerPortPresenter {
  static toResponse(record: ConsoleServerPortRecord): DcimConsoleServerPort {
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
    } as DcimConsoleServerPort;
  }
}
