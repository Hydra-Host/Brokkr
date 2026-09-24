import { Controller, Sse } from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { eventVisibleTo, toWire } from './events.types';
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
    const canReadJobs =
      identity !== undefined &&
      this.contextService.isInstanceOperator &&
      this.contextService.hasPermission('job', 'read');
    this.logger.log(
      `[SSE] Client connected to event stream (org: ${organizationId ?? 'unscoped'}, user: ${userId ?? 'unknown'})`,
    );

    return this.redisPubSub.deviceEvents$.pipe(
      filter((event) => eventVisibleTo(event, { organizationId, canReadJobs })),
      map((event) => ({ data: JSON.stringify(toWire(event)) })),
    );
  }
}
