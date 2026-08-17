import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventLogController } from './event-log.controller';
import { EventLogInterceptor } from './event-log.interceptor';
import { EventLogRepository } from './event-log.repository';
import { EventLogService } from './event-log.service';

/** Global: tier 1 emits live in ~8 feature modules, none of which should import this to get them. */
@Global()
@Module({
  controllers: [EventLogController],
  providers: [EventLogService, EventLogRepository, { provide: APP_INTERCEPTOR, useClass: EventLogInterceptor }],
  exports: [EventLogService],
})
export class EventLogModule {}
