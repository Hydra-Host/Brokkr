import { Controller, Sse } from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { DEVICE_METADATA_UPDATED } from './events.types';
import { RedisPubSubService } from './redis-pubsub.service';

interface SseMessage {
  data: string;
}

@Controller()
export class EventsController {
  constructor(
    private readonly redisPubSub: RedisPubSubService,
    private readonly contextService: ContextService,
    @Logger(EventsController.name) private readonly logger: LoggerService,
  ) {}

  @Sse('api/events/devices')
  streamDeviceEvents(): Observable<SseMessage> {
    const identity = this.contextService.identity;
    const organizationId = identity?.organizationId ?? null;
    const userId = identity ? this.contextService.userId : null;
    this.logger.log(
      `[SSE] Client connected to event stream (org: ${organizationId ?? 'unscoped'}, user: ${userId ?? 'unknown'})`,
    );

    return this.redisPubSub.deviceEvents$.pipe(
      filter((event) => {
        if (!organizationId) return true;
        return event.organizationId === organizationId;
      }),
      map((event) => ({
        data: JSON.stringify({
          type: DEVICE_METADATA_UPDATED,
          deviceId: event.deviceId,
          deploymentId: event.deploymentId,
          status: event.status,
          powerStatus: event.powerStatus,
        }),
      })),
    );
  }
}
