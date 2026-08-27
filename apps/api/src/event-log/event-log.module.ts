import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContextService } from 'src/common/context/context.service';
import { EventLogExportService } from './event-log-export.service';
import { EventLogRetentionCron } from './event-log-retention.cron';
import { EventLogSystemFinalizer } from './event-log-system.finalizer';
import { EventLogController } from './event-log.controller';
import { EventLogInterceptor } from './event-log.interceptor';
import { EventLogRepository } from './event-log.repository';
import { EventLogService } from './event-log.service';

/** Global: tier 1 emits live in ~8 feature modules, none of which should import this to get them. */
@Global()
@Module({
  controllers: [EventLogController],
  providers: [
    EventLogService,
    EventLogExportService,
    EventLogRepository,
    EventLogRetentionCron,
    EventLogSystemFinalizer,
    { provide: APP_INTERCEPTOR, useClass: EventLogInterceptor },
  ],
  exports: [EventLogService, EventLogSystemFinalizer],
})
export class EventLogModule implements OnModuleInit {
  constructor(
    private readonly contextService: ContextService,
    private readonly finalizer: EventLogSystemFinalizer,
  ) {}

  /** Wired here rather than injected into ContextService, which the finalizer depends on. */
  onModuleInit(): void {
    this.contextService.setSystemIntentFinalizer(this.finalizer);
  }
}
