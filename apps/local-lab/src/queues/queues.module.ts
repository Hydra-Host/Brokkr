import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { QueueJobsService } from './queue-jobs.service';
import { QueueMutationsService } from './queue-mutations.service';
import { QueueReaderService } from './queue-reader.service';
import { QueueRegistryService } from './queue-registry.service';
import { QueuesController } from './queues.controller';

@Module({
  imports: [DatastoreModule],
  controllers: [QueuesController],
  providers: [QueueReaderService, QueueRegistryService, QueueJobsService, QueueMutationsService],
  exports: [QueueReaderService, QueueRegistryService, QueueJobsService, QueueMutationsService],
})
export class QueuesModule {}
