import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { LifecycleJobEventsService } from './lifecycle-job-events.service';

@Module({
  controllers: [JobsController],
  providers: [JobsService, LifecycleJobEventsService],
})
export class JobsModule {}
