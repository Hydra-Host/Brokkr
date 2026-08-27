import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { ServicesModule } from '../services/services.module';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  imports: [DatastoreModule, ServicesModule],
  controllers: [ZonesController],
  providers: [ZonesService],
})
export class ZonesModule {}
