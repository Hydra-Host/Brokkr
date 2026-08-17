import { Module } from '@nestjs/common';

import { DatastoreModule } from '../datastore/datastore.module';
import { ServicesModule } from '../services/services.module';
import { AgentWorkReaderService } from './agent-work.reader';
import { LeaderReaderService } from './leader.reader';
import { RuntimeController } from './runtime.controller';
import { VrrpShimReaderService } from './vrrp-shim.reader';
import { VrrpReaderService } from './vrrp.reader';
import { ZoneCryptoReaderService } from './zone-crypto.reader';
import { ZoneRuntimeService } from './zone-runtime.service';

@Module({
  imports: [DatastoreModule, ServicesModule],
  controllers: [RuntimeController],
  providers: [
    LeaderReaderService,
    VrrpReaderService,
    VrrpShimReaderService,
    ZoneCryptoReaderService,
    AgentWorkReaderService,
    ZoneRuntimeService,
  ],
  exports: [ZoneRuntimeService],
})
export class RuntimeModule {}
