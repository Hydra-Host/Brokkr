import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { DatastoreController } from './datastore.controller';
import { DbMigrationsService } from './db-migrations.service';
import { PgService } from './pg.service';
import { RedisConnectionsService } from './redis-connections.service';
import { RedisService } from './redis.service';
import { ThanosService } from './thanos.service';
import { ZoneRegistryService } from './zone-registry.service';

@Module({
  imports: [ServicesModule],
  controllers: [DatastoreController],
  providers: [
    PgService,
    RedisService,
    ThanosService,
    DbMigrationsService,
    ZoneRegistryService,
    RedisConnectionsService,
  ],
  exports: [PgService, RedisService, ThanosService, ZoneRegistryService, RedisConnectionsService],
})
export class DatastoreModule {}
