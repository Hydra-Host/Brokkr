import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { LayersModule } from '../layers/layers.module';
import { RunnerModule } from '../runner/runner.module';
import { ServicesModule } from '../services/services.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [RunnerModule, LayersModule, ServicesModule, DatastoreModule],
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
